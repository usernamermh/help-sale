import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import { config } from "../../backend/env.js";
import { runSalesAgent, stripChartsForHistory } from "../../backend/integrations_pi/agent-runtime.js";
import { appendThreadMessage } from "../../backend/integrations_pi/tables/agents/threads.js";
import { buildContextForThread } from "../../backend/services/context-compress.js";
import type { ModelRuntime } from "../../backend/integrations_pi/models.js";
import type { SessionStore } from "../../backend/integrations_pi/sessions.js";
import { getUpdates, toInbound } from "./ilink.js";
import { createLoginManager } from "./login.js";
import { createWeixinDispatcher, type WeixinAgentRunner } from "./dispatch.js";
import { registerWeixinRoutes, type WeixinContext } from "./routes.js";
import { sendWeixinText, type WeixinSendOptions } from "./send.js";
import { maskId } from "./text.js";
import { WeixinDedup, readAccount, readSyncBuf, setContextToken, writeSyncBuf } from "./store.js";
import { runWeixinCommand } from "./commands.js";
import { publishThreadEvent } from "../../backend/services/thread-events.js";
import type { WeixinAccount, WeixinInbound } from "./types.js";

/**
 * 微信通道装配:扫码登录 → 长轮询收消息 → 跑 agent → 发回微信。
 * 对外只暴露 registerWeixin(app, deps),内部所有状态都在这个文件里收口。
 */

export interface WeixinRuntimeDeps {
	db: DatabaseSync;
	dataDir: string;
	store: SessionStore;
	runtime?: ModelRuntime;
	streamFn?: StreamFn;
	/** 多实例:只有主实例才拉 iLink 消息(同一条游标不能被两个进程抢) */
	isLeader?: () => boolean;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** 本轮之前的会话历史:MCP/向量等上下文压缩逻辑与网页端共用同一套。 */
function weixinHistory(db: DatabaseSync) {
	return async (input: { tenantId: string; threadId: string; goal: string }): Promise<AgentMessage[]> => {
		const built = buildContextForThread(db, input.tenantId, input.threadId, { goal: input.goal });
		return built.messages.map((message) => ({
			role: message.role as AgentMessage["role"],
			content: stripChartsForHistory(message.content),
		})) as AgentMessage[];
	};
}

/**
 * 把一条微信消息送进 agent 链路。聊天渠道没有流式界面,也不该等服务端多代理汇总,
 * 所以走单 Agent 一次执行(不启用 emit_plan / 看板子代理),跑完必有最终回答。
 */
function createAgentRunner(deps: WeixinRuntimeDeps): WeixinAgentRunner {
	return async ({ tenantId, threadId, goal, history }) => {
		const result = await runSalesAgent(
			{ db: deps.db, tenantId, store: deps.store, runtime: deps.runtime, streamFn: deps.streamFn },
			{ goal, history, threadId },
		);
		const answer = result.final?.answer ?? "";
		if (answer) {
			appendThreadMessage(deps.db, tenantId, threadId, "assistant", [{ type: "text", text: answer }]);
			publishThreadEvent({ type: "message", tenantId, threadId, role: "assistant", text: answer });
		}
		return { runId: result.runId, answer };
	};
}

export function registerWeixin(app: FastifyInstance, deps: WeixinRuntimeDeps): () => void {
	const tenantId = config.weixinTenantId;
	const log = (line: string) => {
		if (config.logEnabled) console.log(line);
	};

	if (!config.weixinEnabled) {
		registerWeixinRoutes(app, {
			enabled: false,
			tenantId,
			db: deps.db,
			status: () => ({ enabled: false, loggedIn: false, polling: false }),
			startLogin: async () => {
				throw new Error("微信通道未启用（weixin.enabled=false）。");
			},
			pollLogin: async () => {
				throw new Error("微信通道未启用（weixin.enabled=false）。");
			},
			sendText: async () => ({ ok: false, chunks: 0, error: "微信通道未启用（weixin.enabled=false）。" }),
			logout: () => undefined,
			stop: () => undefined,
		});
		return () => undefined;
	}

	let account: WeixinAccount | undefined =
		config.weixinAccountId && config.weixinToken
			? { accountId: config.weixinAccountId, token: config.weixinToken, baseUrl: config.weixinBaseUrl, userId: "", savedAt: "" }
			: readAccount(deps.dataDir);

	const sendOptions = (): WeixinSendOptions | undefined =>
		account
			? {
					dataDir: deps.dataDir,
					baseUrl: account.baseUrl || config.weixinBaseUrl,
					accountId: account.accountId,
					token: account.token,
					maxLength: config.weixinMaxMessageLength,
					retries: config.weixinSendRetries,
					retryDelayMs: config.weixinSendRetryDelayMs,
				}
			: undefined;

	const state = {
		running: false,
		startedAt: Date.now(),
		lastPollAt: 0,
		lastError: "",
		handled: 0,
		stopRequested: false,
	};

	const login = createLoginManager({
		dataDir: deps.dataDir,
		baseUrl: config.weixinBaseUrl,
		botType: config.weixinBotType,
		timeoutMs: config.weixinPollTimeoutMs,
		ticketTtlMs: 10 * 60 * 1000,
	});

	const dedup = new WeixinDedup(config.weixinDedupTtlSeconds * 1000);

	let stopPoller: () => void = () => undefined;

	const agentRunner = createAgentRunner(deps);

	const dispatchInbound = async (inbound: WeixinInbound): Promise<void> => {
		if (inbound.contextToken && account) {
			setContextToken(deps.dataDir, account.accountId, inbound.fromUserId, inbound.contextToken);
		}
		const options = sendOptions();
		if (!options) return;
		const dispatcher = createWeixinDispatcher({
			db: deps.db,
			tenantId,
			autoReply: config.weixinAutoReply,
			agentTimeoutMs: config.weixinAgentTimeoutMs,
			allowFrom: config.weixinAllowFrom,
			unsupportedText: config.weixinUnsupportedText,
			ackText: config.weixinAckText,
			send: options,
			runAgent: agentRunner,
			buildHistory: weixinHistory(deps.db),
			handleCommand: config.weixinCommandsEnabled
				? (input) => runWeixinCommand({ db: deps.db, tenantId, openid: input.openid, sessionsLimit: config.weixinSessionsLimit, status: currentStatus }, input.text)
				: undefined,
			onLog: log,
		});
		await dispatcher(inbound);
		state.handled += 1;
	};

	const startPoller = (): void => {
		if (!account || state.running) return;
		state.running = true;
		state.stopRequested = false;
		let syncBuf = readSyncBuf(deps.dataDir, account.accountId);
		void (async () => {
			let failures = 0;
			while (!state.stopRequested) {
				// 多实例:非主实例不拉消息(等待接管),避免两个进程抢同一条游标
				if (deps.isLeader && !deps.isLeader()) {
					await sleep(2000);
					continue;
				}
				const current = account;
				if (!current) break;
				try {
					const response = await getUpdates({
						baseUrl: current.baseUrl || config.weixinBaseUrl,
						token: current.token,
						timeoutMs: config.weixinPollTimeoutMs,
						syncBuf,
					});
					const suggested = Number(response.longpolling_timeout_ms ?? 0);
					if (Number.isFinite(suggested) && suggested > 0) {
						// 服务端给的建议值优先用于下一轮超时
					}
					const ret = Number(response.ret ?? 0);
					const errcode = Number(response.errcode ?? 0);
					if (ret !== 0 || errcode !== 0) {
						const expired = ret === -14 || errcode === -14;
						state.lastError = `getupdates ret=${ret} errcode=${errcode} ${String(response.errmsg ?? "")}`.trim();
						log(`[weixin] ${state.lastError}`);
						await sleep(expired ? 600_000 : Math.min(30_000, 2_000 * Math.max(1, ++failures)));
						continue;
					}
					failures = 0;
					state.lastError = "";
					state.lastPollAt = Date.now();
					const nextBuf = String(response.get_updates_buf ?? "");
					if (nextBuf && nextBuf !== syncBuf) {
						syncBuf = nextBuf;
						writeSyncBuf(deps.dataDir, current.accountId, syncBuf);
					}
					const messages = Array.isArray(response.msgs) ? response.msgs : [];
					for (const raw of messages) {
						if (!raw || typeof raw !== "object") continue;
						const inbound = toInbound(raw as Record<string, unknown>);
						if (!inbound.fromUserId || inbound.fromUserId === current.accountId) continue;
						const key = inbound.messageId ? `id:${inbound.messageId}` : `text:${inbound.fromUserId}:${JSON.stringify(inbound.items).slice(0, 200)}`;
						if (dedup.isDuplicate(key)) continue;
						try {
							await dispatchInbound(inbound);
						} catch (error) {
							log(`[weixin] 入站处理失败: ${error instanceof Error ? error.message : String(error)}`);
						}
					}
				} catch (error) {
					failures += 1;
					state.lastError = error instanceof Error ? error.message : String(error);
					log(`[weixin] 轮询失败(${failures}): ${state.lastError}`);
					await sleep(Math.min(30_000, 2_000 * failures));
				}
			}
			state.running = false;
		})();
	};

	stopPoller = () => {
		state.stopRequested = true;
	};

	if (account) startPoller();
	else log("[weixin] 尚未登录:调用 POST /api/v1/weixin/login 扫码后开始收消息");

	const currentStatus = (): Record<string, unknown> => ({
			enabled: true,
			loggedIn: Boolean(account),
			accountId: account ? maskId(account.accountId) : null,
			baseUrl: account?.baseUrl ?? config.weixinBaseUrl,
			polling: state.running,
		// 多实例:只有主实例真正拉消息,这里直接暴露出来,便于确认"谁在拉"
		leader: deps.isLeader ? deps.isLeader() : true,
			lastPollAt: state.lastPollAt ? new Date(state.lastPollAt).toISOString() : null,
			lastError: state.lastError || null,
			handled: state.handled,
			autoReply: config.weixinAutoReply,
			tenantId,
		allowFromCount: config.weixinAllowFrom.length,
	});

	const ctx: WeixinContext = {
		enabled: true,
		tenantId,
		db: deps.db,
		status: currentStatus,
		startLogin: async () => {
			const ticket = await login.start();
			return ticket;
		},
		pollLogin: async (id: string) => {
			const ticket = await login.poll(id);
			if (ticket.status === "confirmed") {
				account = readAccount(deps.dataDir);
				startPoller();
			}
			return ticket;
		},
		sendText: async (to: string, text: string) => {
			const options = sendOptions();
			if (!options) return { ok: false, chunks: 0, error: "尚未登录微信，请先在控制台扫码登录。" };
			return sendWeixinText(options, to, text);
		},
		logout: () => {
			stopPoller();
			account = undefined;
			state.stopRequested = true;
		},
		stop: stopPoller,
	};

	registerWeixinRoutes(app, ctx);
	return () => stopPoller();
}