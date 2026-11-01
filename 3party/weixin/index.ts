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
import { createLoginManager, type LoginManager, type LoginTicket } from "./login.js";
import { createWeixinDispatcher, type WeixinAgentRunner } from "./dispatch.js";
import { registerWeixinRoutes, type WeixinContext } from "./routes.js";
import { sendWeixinText, type WeixinSendOptions } from "./send.js";
import { maskId } from "./text.js";
import { WeixinDedup, clearAccount, listTenantStateIds, readAccount, readSyncBuf, setContextToken, writeAccount, writeSyncBuf } from "./store.js";
import { runWeixinCommand } from "./commands.js";
import type { TenantQuota } from "../../backend/services/tenant-quota.js";
import { publishThreadEvent } from "../../backend/services/thread-events.js";
import type { WeixinAccount, WeixinInbound, WeixinSendResult } from "./types.js";

/**
 * 微信通道装配:**按门店(租户)各登录一个机器人**。
 *
 * 形态是"门店即租户",所以:
 *   - 账号凭据、同步游标、context_token、去重窗口全部按门店分槽(data/weixin/tenants/<门店>);
 *   - 每个门店一个轮询循环,多实例下各自选主(同一个游标不能被两个进程抢);
 *   - 一个门店同时只保留一个登录账号(再登录就是换账号:先清旧的再写新的);
 *   - 路由挂在门店层(门店自己扫码登录),总部在平台层只看"哪些门店登录了/掉线了"。
 */

export interface WeixinRuntimeDeps {
	db: DatabaseSync;
	dataDir: string;
	store: SessionStore;
	runtime?: ModelRuntime;
	streamFn?: StreamFn;
	/** 每租户额度:微信侧的 agent 轮次同样受限,超限先等一会儿再回忙话术 */
	quota?: TenantQuota;
	/** 多实例:按门店选主(只有持锁实例拉该门店的消息) */
	isLeader?: (tenantId: string) => boolean;
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

/** 一条微信消息送进 agent 链路(聊天渠道走单 Agent 一次执行,不启用看板子代理)。 */
function createAgentRunner(deps: WeixinRuntimeDeps): WeixinAgentRunner {
	return async ({ tenantId, threadId, goal, history }) => {
		let slot = await deps.quota?.tryAcquireAgentRun(tenantId);
		if (slot && !slot.allowed) {
			for (let attempt = 0; attempt < 3 && slot && !slot.allowed; attempt++) {
				await sleep(Math.min(5000, Math.max(1000, slot.retryAfterMs)));
				slot = await deps.quota!.tryAcquireAgentRun(tenantId);
			}
			if (!slot.allowed) return { answer: config.weixinBusyText };
		}
		try {
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
		} finally {
			if (slot?.allowed) await deps.quota?.releaseAgentRun(tenantId);
		}
	};
}

export interface WeixinTenantStatus {
	tenantId: string;
	enabled: boolean;
	loggedIn: boolean;
	accountId: string | null;
	polling: boolean;
	leader: boolean;
	lastPollAt: string | null;
	lastError: string | null;
	handled: number;
	allowFromCount: number;
}

export interface WeixinTenantRuntime {
	tenantId: string;
	start(): void;
	stop(): void;
	status(): WeixinTenantStatus;
	startLogin(): Promise<LoginTicket>;
	pollLogin(id: string): Promise<LoginTicket>;
	sendText(to: string, text: string): Promise<WeixinSendResult>;
	logout(): void;
}

export function registerWeixin(app: FastifyInstance, deps: WeixinRuntimeDeps): () => void {
	const log = (line: string) => {
		if (config.logEnabled) console.log(line);
	};
	const agentRunner = createAgentRunner(deps);
	const runtimes = new Map<string, WeixinTenantRuntime>();

	const createRuntime = (tenantId: string): WeixinTenantRuntime => {
		let account: WeixinAccount | undefined =
			config.weixinTenantId === tenantId && config.weixinAccountId && config.weixinToken
				? { accountId: config.weixinAccountId, token: config.weixinToken, baseUrl: config.weixinBaseUrl, userId: "", savedAt: "" }
				: readAccount(deps.dataDir, tenantId);

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

		const state = { running: false, lastPollAt: 0, lastError: "", handled: 0, stopRequested: false };
		const login: LoginManager = createLoginManager({
			dataDir: deps.dataDir,
			tenantId,
			baseUrl: config.weixinBaseUrl,
			botType: config.weixinBotType,
			timeoutMs: config.weixinPollTimeoutMs,
			ticketTtlMs: 10 * 60 * 1000,
		});
		const dedup = new WeixinDedup(config.weixinDedupTtlSeconds * 1000);

		const dispatchInbound = async (inbound: WeixinInbound): Promise<void> => {
			if (inbound.contextToken && account) setContextToken(deps.dataDir, account.accountId, inbound.fromUserId, inbound.contextToken, tenantId);
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
					? (input) => runWeixinCommand({ db: deps.db, tenantId, openid: input.openid, sessionsLimit: config.weixinSessionsLimit, status: () => ({}) }, input.text)
					: undefined,
				onLog: log,
			});
			await dispatcher(inbound);
			state.handled += 1;
		};

		const start = (): void => {
			if (!account || state.running) return;
			state.running = true;
			state.stopRequested = false;
			let syncBuf = readSyncBuf(deps.dataDir, account.accountId, tenantId);
			void (async () => {
				let failures = 0;
				while (!state.stopRequested) {
					// 多实例:该门店的非主实例不拉消息(等待接管),避免两个进程抢同一条游标
					if (deps.isLeader && !deps.isLeader(tenantId)) {
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
						const ret = Number(response.ret ?? 0);
						const errcode = Number(response.errcode ?? 0);
						if (ret !== 0 || errcode !== 0) {
							const expired = ret === -14 || errcode === -14;
							state.lastError = `getupdates ret=${ret} errcode=${errcode} ${String(response.errmsg ?? "")}`.trim();
							log(`[weixin:${tenantId}] ${state.lastError}`);
							await sleep(expired ? 600_000 : Math.min(30_000, 2_000 * Math.max(1, ++failures)));
							continue;
						}
						failures = 0;
						state.lastError = "";
						state.lastPollAt = Date.now();
						const nextBuf = String(response.get_updates_buf ?? "");
						if (nextBuf && nextBuf !== syncBuf) {
							syncBuf = nextBuf;
							writeSyncBuf(deps.dataDir, current.accountId, syncBuf, tenantId);
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
								log(`[weixin:${tenantId}] 入站处理失败: ${error instanceof Error ? error.message : String(error)}`);
							}
						}
					} catch (error) {
						failures += 1;
						state.lastError = error instanceof Error ? error.message : String(error);
						log(`[weixin:${tenantId}] 轮询失败(${failures}): ${state.lastError}`);
						await sleep(Math.min(30_000, 2_000 * failures));
					}
				}
				state.running = false;
			})();
		};

		const status = (): WeixinTenantStatus => ({
			tenantId,
			enabled: config.weixinEnabled,
			loggedIn: Boolean(account),
			accountId: account ? maskId(account.accountId) : null,
			polling: state.running,
			leader: deps.isLeader ? deps.isLeader(tenantId) : true,
			lastPollAt: state.lastPollAt ? new Date(state.lastPollAt).toISOString() : null,
			lastError: state.lastError || null,
			handled: state.handled,
			allowFromCount: config.weixinAllowFrom.length,
		});

		return {
			tenantId,
			start,
			stop: () => {
				state.stopRequested = true;
			},
			status,
			startLogin: async () => login.start(),
			pollLogin: async (id: string) => {
				const ticket = await login.poll(id);
				if (ticket.status === "confirmed") {
					// 一个门店同时只保留一个登录账号:换账号 = 覆盖旧凭据
					account = readAccount(deps.dataDir, tenantId);
					start();
				}
				return ticket;
			},
			sendText: async (to: string, text: string) => {
				const options = sendOptions();
				if (!options) return { ok: false, chunks: 0, error: "尚未登录微信,请先在控制台扫码登录。" };
				return sendWeixinText(options, to, text);
			},
			logout: () => {
				state.stopRequested = true;
				account = undefined;
				clearAccount(deps.dataDir, tenantId);
				log(`[weixin:${tenantId}] 已退出登录(门店需要重新扫码)`);
			},
		};
	};

	const runtimeFor = (tenantId: string): WeixinTenantRuntime => {
		const id = String(tenantId ?? "").trim();
		if (!id) throw new Error("微信通道需要门店(租户)标识。");
		const existing = runtimes.get(id);
		if (existing) return existing;
		const created = createRuntime(id);
		runtimes.set(id, created);
		return created;
	};

	const migrateLegacyAccount = (): void => {
		// 老部署是"单账号 + weixin.tenantId"一份状态;第一次启动时把它归到那个门店的槽位
		const legacy = readAccount(deps.dataDir);
		if (!legacy || !config.weixinTenantId) return;
		if (readAccount(deps.dataDir, config.weixinTenantId)) return;
		writeAccount(deps.dataDir, legacy, config.weixinTenantId);
		clearAccount(deps.dataDir);
		log(`[weixin] 已把历史登录状态迁移到门店槽位:${config.weixinTenantId}`);
	};
	migrateLegacyAccount();

	if (!config.weixinEnabled) {
		log("[weixin] 通道未启用(weixin.enabled=false):只挂状态接口");
	} else {
		// 磁盘上已登录过的门店各自拉起轮询;之后新登录的门店在 pollLogin 里启动
		for (const tenantId of listTenantStateIds(deps.dataDir)) {
			if (readAccount(deps.dataDir, tenantId)) runtimeFor(tenantId).start();
		}
		if (runtimes.size === 0) log("[weixin] 还没有门店登录:各门店在自己的控制台调用 POST /api/v1/weixin/login 扫码后开始收消息");
	}

	const ctx: WeixinContext = {
		enabled: config.weixinEnabled,
		db: deps.db,
		runtime: runtimeFor,
		statusAll: () => [...runtimes.values()].map((rt) => rt.status()),
		stop: (tenantId?: string) => {
			if (tenantId) {
				runtimes.get(tenantId)?.stop();
				return;
			}
			for (const rt of runtimes.values()) rt.stop();
		},
	};

	registerWeixinRoutes(app, ctx);
	return () => ctx.stop();
}