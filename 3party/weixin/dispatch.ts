import type { DatabaseSync } from "node:sqlite";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { appendThreadMessage, createThread, setThreadTitle } from "../../backend/integrations_pi/tables/agents/threads.js";
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
	/** 本轮之前的会话历史(不含本轮这条用户消息) */
	history: AgentMessage[];
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
	/** 收到消息后立刻回一条"已收到";留空表示不回 */
	ackText: string;
	send: WeixinSendOptions;
	runAgent: WeixinAgentRunner;
	/** 组装本轮之前的会话历史(在写入本轮用户消息之前调用) */
	buildHistory?: (input: { tenantId: string; threadId: string; goal: string }) => Promise<AgentMessage[]>;
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

	/**
	 * 入队前的准入:查白名单、去重、写入站审计。
	 * 返回 undefined 表示这条消息不该处理(未授权/重复);返回空串表示非文字消息。
	 */
	const admit = (inbound: WeixinInbound): string | undefined => {
		const openid = inbound.fromUserId;
		if (!openid) return undefined;
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
			return undefined;
		}
		if (isMessageRecorded(options.db, options.tenantId, inbound.messageId)) {
			log(`[weixin] 跳过重复消息 ${maskId(inbound.messageId)}`);
			return undefined;
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
		return text;
	};

	const handle = async (inbound: WeixinInbound, text: string): Promise<void> => {
		const openid = inbound.fromUserId;
		if (!openid) return;
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

		// 先把本轮消息落进线程:网页历史里这条会话立刻可见可打开,agent 还在跑也不会是空会话
		const title = text.replace(/\s+/g, " ").trim();
		setThreadTitle(options.db, options.tenantId, threadId, title.length > 24 ? `${title.slice(0, 24)}…` : title);
		let history: AgentMessage[] = [];
		if (options.buildHistory) {
			try {
				history = await options.buildHistory({ tenantId: options.tenantId, threadId, goal });
			} catch (error) {
				log(`[weixin] 组装历史失败(按无历史处理): ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		appendThreadMessage(options.db, options.tenantId, threadId, "user", [{ type: "text", text }]);

		let answer = "";
		let runId: string | undefined;
		try {
			const result = await withTimeout(options.runAgent({ tenantId: options.tenantId, threadId, goal, history }), options.agentTimeoutMs, "agent 执行超时");
			answer = result.answer?.trim() ?? "";
			runId = result.runId;
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

	/** 入队前先回一条确认:同一联系人连发多条时,第二条也不会等到前一条跑完才有反馈。 */
	const acknowledge = async (openid: string, text: string): Promise<void> => {
		if (!options.autoReply || !options.ackText || !text) return;
		try {
			await reply(options, openid, options.ackText, undefined, undefined);
		} catch (error) {
			log(`[weixin] 回确认失败: ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	return async (inbound: WeixinInbound): Promise<void> => {
		const key = inbound.fromUserId || "unknown";
		const text = admit(inbound);
		if (text === undefined) return;
		await acknowledge(key, text);
		const previous = chains.get(key) ?? Promise.resolve();
		const next = previous.then(() => handle(inbound, text)).catch((error: unknown) => {
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