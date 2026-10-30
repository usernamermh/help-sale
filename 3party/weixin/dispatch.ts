import type { DatabaseSync } from "node:sqlite";
import { createThread, setThreadTitle } from "../../backend/integrations_pi/tables/agents/threads.js";
import { extractText, maskId } from "./text.js";
import { ensureWeixinUser, isMessageRecorded, recordWeixinMessage, setWeixinThread, getWeixinUser } from "./tables.js";
import type { WeixinSendOptions } from "./send.js";
import type { WeixinInbound } from "./types.js";
import { sendWeixinText } from "./send.js";

/** 一条微信消息 → 一条 agent 线程 → 一条微信回复。 */

export interface AgentRunInput {
	tenantId: string;
	threadId: string;
	goal: string;
}

export interface AgentRunOutput {
	runId?: string;
	answer: string;
}

export type WeixinAgentRunner = (input: AgentRunInput) => Promise<AgentRunOutput>;

export interface WeixinDispatchOptions {
	db: DatabaseSync;
	tenantId: string;
	autoReply: boolean;
	agentTimeoutMs: number;
	allowFrom: string[];
	unsupportedText: string;
	send: WeixinSendOptions;
	runAgent: WeixinAgentRunner;
	onLog?: (line: string) => void;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), Math.max(1, ms));
		timer.unref?.();
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

/**
 * 同一个微信联系人的消息串行处理:两条消息同时到也不会把一条线程写乱。
 * 返回的函数可以直接丢给轮询器,内部已做异常兜底。
 */
export function createWeixinDispatcher(options: WeixinDispatchOptions): (inbound: WeixinInbound) => Promise<void> {
	const chains = new Map<string, Promise<void>>();
	const log = options.onLog ?? (() => undefined);

	const handle = async (inbound: WeixinInbound): Promise<void> => {
		const openid = inbound.fromUserId;
		if (!openid) return;
		if (options.allowFrom.length > 0 && !options.allowFrom.includes(openid)) {
			log(`[weixin] 忽略未授权联系人 ${maskId(openid)}`);
			recordWeixinMessage(options.db, {
				tenantId: options.tenantId,
				openid,
				direction: "in",
				messageId: inbound.messageId,
				msgType: "text",
				content: extractText(inbound.items).slice(0, 200),
				status: "blocked",
				error: "allowFrom 未包含该联系人",
			});
			return;
		}
		if (isMessageRecorded(options.db, options.tenantId, inbound.messageId)) {
			log(`[weixin] 跳过重复消息 ${maskId(inbound.messageId)}`);
			return;
		}

		const text = extractText(inbound.items);
		recordWeixinMessage(options.db, {
			tenantId: options.tenantId,
			openid,
			direction: "in",
			messageId: inbound.messageId,
			msgType: text ? "text" : "unsupported",
			content: text,
			status: "received",
		});

		if (!text) {
			if (options.autoReply) {
				await reply(options, openid, options.unsupportedText, undefined, undefined);
			}
			return;
		}

		const user = ensureWeixinUser(options.db, options.tenantId, openid);
		let threadId = user.threadId;
		if (!threadId) {
			const thread = createThread(options.db, options.tenantId);
			setWeixinThread(options.db, options.tenantId, openid, thread.id);
			threadId = thread.id;
		}

		const goal = user.boundKind && user.boundId ? `(微信联系人已绑定${user.boundKind}:${user.boundId})\n${text}` : text;
		let answer = "";
		let runId: string | undefined;
		try {
			const result = await withTimeout(options.runAgent({ tenantId: options.tenantId, threadId, goal }), options.agentTimeoutMs, "agent 执行超时");
			answer = result.answer?.trim() ?? "";
			runId = result.runId;
			if (answer) {
				const title = text.replace(/\s+/g, " ").trim();
				setThreadTitle(options.db, options.tenantId, threadId, title.length > 24 ? `${title.slice(0, 24)}…` : title);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log(`[weixin] agent 失败 openid=${maskId(openid)}: ${message}`);
			recordWeixinMessage(options.db, {
				tenantId: options.tenantId,
				openid,
				direction: "out",
				msgType: "text",
				content: "",
				threadId,
				status: "failed",
				error: message,
			});
			if (options.autoReply) await reply(options, openid, options.unsupportedText, threadId, undefined);
			return;
		}

		if (!answer) {
			log(`[weixin] agent 没有产出回答 openid=${maskId(openid)}`);
			return;
		}
		if (!options.autoReply) {
			log(`[weixin] autoReply=false,回答未发送 openid=${maskId(openid)}`);
			return;
		}
		await reply(options, openid, answer, threadId, runId);
	};

	return (inbound: WeixinInbound): Promise<void> => {
		const key = inbound.fromUserId || "unknown";
		const previous = chains.get(key) ?? Promise.resolve();
		const next = previous.then(() => handle(inbound)).catch((error: unknown) => {
			log(`[weixin] 处理消息失败: ${error instanceof Error ? error.message : String(error)}`);
		});
		chains.set(key, next);
		void next.finally(() => {
			if (chains.get(key) === next) chains.delete(key);
		});
		return next;
	};
}

async function reply(
	options: WeixinDispatchOptions,
	openid: string,
	text: string,
	threadId: string | undefined,
	runId: string | undefined,
): Promise<void> {
	const result = await sendWeixinText(options.send, openid, text);
	recordWeixinMessage(options.db, {
		tenantId: options.tenantId,
		openid,
		direction: "out",
		msgType: "text",
		content: text,
		threadId,
		runId,
		status: result.ok ? "sent" : "failed",
		error: result.error,
	});
	if (!result.ok) {
		options.onLog?.(`[weixin] 发送失败 openid=${maskId(openid)}: ${result.error ?? "unknown"}`);
	}
}

/** 供路由层查"这个联系人绑定了谁"。 */
export function weixinBindingOf(db: DatabaseSync, tenantId: string, openid: string): { kind: string | null; id: string | null } {
	const user = getWeixinUser(db, tenantId, openid);
	return { kind: user?.boundKind ?? null, id: user?.boundId ?? null };
}