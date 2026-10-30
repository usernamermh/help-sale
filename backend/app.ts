import type { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { openDatabase } from "./db/database.js";
import { config } from "./env.js";
import { openSessionStore } from "./integrations_pi/sessions.js";
import { requireTenant } from "./integrations_pi/tables/crm/customers.js";
import type { ModelRuntime } from "./integrations_pi/models.js";
import { registerRoutes } from "./services/routes/index.js";
import type { RouteDeps } from "./services/routes/index.js";
import { registerMcp } from "./mcp/index.js";
import { startMcpToolWarmup } from "./mcp/warmup.js";
import { warmupAgentTools } from "./integrations_pi/agent-tools.js";
import { registerWeixin } from "../3party/weixin/index.js";
import { resolveTenant } from "./services/tenant-context.js";
import { withTenantGuard } from "./db/tenant-guard.js";
import { createSyncMysqlDb } from "./db/mysql/client.js";
import { createReminderQueue, type ReminderQueue } from "./integrations_db/reminder-queue.js";
import { closeStopSignal, initStopSignal } from "./services/stop-signal.js";
import { appendRuntimeLog } from "./services/runtime-log.js";
import { startAutomationScheduler } from "./services/routes/automation.js";
import { startSubagentConsumer } from "./services/routes/agent/index.js";

// FastifyRequest.tenantId 的类型增强声明在 services/routes/helpers.ts(路由层公共文件)

export interface AppOptions {
	logger?: boolean;
	dataDir?: string;
	runtime?: ModelRuntime;
	streamFn?: StreamFn;
	/** 是否在启动时确保默认租户存在(默认 true;测试可传 false) */
	ensureTenant?: boolean;
	reminders?: ReminderQueue;
	automation?: boolean; // 是否启动定时自动任务(默认 false,生产入口 true)
	subagents?: boolean; // 是否启动子代理消费者(默认 false,生产入口 true)
}

/**
 * 应用装配:数据库/会话库 → 路由 → MCP → 静态页 → 定时任务与子代理消费者。
 * 业务逻辑都在 services/routes/<功能>.ts,这里只做接线。
 */
export function buildApp(options: AppOptions = {}): FastifyInstance {
	const app = Fastify({ logger: options.logger ?? false });

	const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
	const frontDir = path.join(repoRoot, "front");
	const configured = options.dataDir ?? config.dataDir;
	const dataDir = path.isAbsolute(configured) ? configured : path.join(repoRoot, configured);
	mkdirSync(dataDir, { recursive: true });

	const logDir = path.isAbsolute(config.logDir) ? config.logDir : path.join(repoRoot, config.logDir);
	appendRuntimeLog(logDir, { level: "debug", type: "startup", message: `应用启动,日志目录: ${logDir} (级别 ${config.logLevel})` }, {
		fileName: config.logRuntimeFile,
		level: config.logLevel,
		maxBytes: config.logMaxBytes,
	});

	// 数据库路径默认来自配置;测试显式指定 dataDir 时仍落在临时目录
	const resolveDbPath = (p: string) => (path.isAbsolute(p) ? p : path.join(repoRoot, p));
	const businessDbPath = options.dataDir ? path.join(dataDir, "business.db") : resolveDbPath(config.businessDbPath);
	const sessionDbPath = options.dataDir ? path.join(dataDir, "pi-sessions.db") : resolveDbPath(config.sessionDbPath);
	// 数据存储二选一:local = SQLite 业务库;mysql = 远程 MySQL 业务库(同步桥,仓库层零改动)
	// 显式传入 dataDir(测试/嵌入式)时一定用本地 SQLite,避免碰到生产 MySQL
	const rawDb: DatabaseSync =
		options.dataDir || config.dataMode !== "mysql" ? openDatabase(businessDbPath) : (createSyncMysqlDb() as unknown as DatabaseSync);
	// 租户隔离强制点:业务表语句缺 tenant_id 谓词时按配置告警或直接拦下(MySQL 没有 RLS,这里做应用层强制)
	const db: DatabaseSync = config.tenantDataIsolationMode === "off"
		? rawDb
		: withTenantGuard(rawDb, { tables: config.tables, mode: config.tenantDataIsolationMode });
	const store = openSessionStore(dataDir, sessionDbPath);

	if (options.ensureTenant !== false) requireTenant(db, config.tenantId, "示例租户");

	app.decorateRequest("tenantId", "");
	// 租户不再由调用方随意声明:凭证(API Key)优先,请求头只在配置允许时才认,且要落在受信清单内
	app.addHook("preHandler", async (request, reply) => {
		const resolved = resolveTenant({
			headers: request.headers as Record<string, string | string[] | undefined>,
			apiKeys: config.tenantApiKeys,
			headerAllowed: config.tenantHeaderAllowed,
			trustedTenantIds: config.tenantTrustedIds,
			defaultTenantId: config.tenantId,
		});
		if (resolved.error) {
			appendRuntimeLog(logDir, {
				level: "error",
				type: "tenant_rejected",
				message: `${request.method} ${request.url} 租户校验失败: ${resolved.error.message}`,
				meta: { tenantHeader: (request.headers["x-tenant-id"] as string | undefined) ?? null },
			}, { fileName: config.logRuntimeFile, level: config.logLevel, maxBytes: config.logMaxBytes });
			return reply.code(resolved.error.status).send({ error: "tenant_not_allowed", message: resolved.error.message });
		}
		request.tenantId = resolved.tenantId ?? config.tenantId;
	});

	initStopSignal({
		enabled: config.redisEnabled,
		host: config.redisHost,
		port: config.redisPort,
		password: config.redisPassword,
	});
	const reminders = options.reminders ?? createReminderQueue({
		enabled: config.redisEnabled,
		host: config.redisHost,
		port: config.redisPort,
		password: config.redisPassword,
	});

	const deps: RouteDeps = { db, store, dataDir, logDir, runtime: options.runtime, streamFn: options.streamFn, reminders };

	// 工具装配预热:后台跑,不挡启动;第一条消息就不会为"冷装配"买单
	if (!process.env.VITEST) {
		void warmupAgentTools({ db, tenantId: config.tenantId, store })
			.then((r) => console.log(`[warmup] 工具装配预热完成: ${r.toolCount} 个工具,${r.ms}ms`))
			.catch((error: unknown) => console.warn(`[warmup] 工具装配预热失败: ${error instanceof Error ? error.message : String(error)}`));
	}
	registerRoutes(app, deps);
	registerMcp(app, { db, tenantId: config.tenantId });
	// 外部 MCP 工具列表:启动就预热,之后在缓存过期前后台续期,别让用户消息等外部握手
	const stopMcpWarmup = startMcpToolWarmup(config.mcpServers);
	// 微信通道(iLink 机器人):扫码登录、长轮询收消息、agent 回复;未启用时只挂状态接口
	const stopWeixin = registerWeixin(app, { db, dataDir, store, runtime: options.runtime, streamFn: options.streamFn });

	app.addHook("onResponse", async (request, reply) => {
		if (!request.url.startsWith("/api/")) return;
		appendRuntimeLog(logDir, {
			level: "info",
			type: "request",
			message: `${request.method} ${request.url} -> ${reply.statusCode}`,
			meta: { tenantId: request.tenantId, elapsedMs: reply.elapsedTime },
		}, { fileName: config.logRuntimeFile, level: config.logLevel, maxBytes: config.logMaxBytes });
	});
	app.addHook("onError", async (request, reply, error) => {
		appendRuntimeLog(logDir, {
			level: "error",
			type: "error",
			message: `${request.method} ${request.url} -> ${reply.statusCode}: ${error.message}`,
			meta: { tenantId: request.tenantId, stack: error.stack },
		}, { fileName: config.logRuntimeFile, level: config.logLevel, maxBytes: config.logMaxBytes });
	});

	// ── 静态页(front/):client.html 外壳 + client_functions 内联拼接 + vendor 原样返回 ──
	const injectClientConfig = (html: string) =>
		html.split("__CLIENT_CONFIG__").join(JSON.stringify({ tenantId: config.tenantId, workflowMineTimeoutMs: config.workflowMineTimeoutMs }));
	const injectTenant = (html: string) => html.split("__APP_TENANT_ID__").join(JSON.stringify(config.tenantId));
	const CLIENT_FUNC_FILES = ["base.js", "charts.js", "origin_dialog.js", "subagents_record.js", "current_turn_record.js", "function_supports.js", "history_dialogs.js", "keywords_manager.js", "ontime_tasks.js", "workflow.js", "live_updates.js", "init.js"];
	const clientFuncsHtml = () =>
		CLIENT_FUNC_FILES.map((f) => "<script>\n" + readFileSync(path.join(frontDir, "client_functions", f), "utf8") + "\n</script>").join("\n");
	const renderClient = () =>
		injectClientConfig(injectTenant(readFileSync(path.join(frontDir, "client.html"), "utf8").replace("<!--CLIENT_FUNCTIONS-->", clientFuncsHtml())));

	app.get("/", async (_request, reply) => {
		reply.header("Cache-Control", "no-store").type("text/html; charset=utf-8").send(renderClient());
	});
	app.get("/console", async (_request, reply) => {
		reply.header("Cache-Control", "no-store").type("text/html; charset=utf-8").send(injectClientConfig(injectTenant(readFileSync(path.join(frontDir, "console.html"), "utf8"))));
	});
	app.get<{ Params: { file: string } }>("/vendor/:file", async (request, reply) => {
		const name = request.params.file;
		if (!/^[\w.-]+\.js$/.test(name)) return reply.code(404).send({ error: "not_found" });
		try {
			return reply.type("text/javascript; charset=utf-8").send(readFileSync(path.join(frontDir, "vendor", name), "utf8"));
		} catch {
			return reply.code(404).send({ error: "not_found" });
		}
	});
	app.get<{ Params: { file: string } }>("/client_functions/:file", async (request, reply) => {
		const name = request.params.file;
		if (!/^[\w-]+\.js$/.test(name)) return reply.code(404).send({ error: "not_found" });
		try {
			return reply.type("text/javascript; charset=utf-8").send(readFileSync(path.join(frontDir, "client_functions", name), "utf8"));
		} catch {
			return reply.code(404).send({ error: "not_found" });
		}
	});

	// ── 后台常驻任务:定时自动化 + 子代理消费者(按配置与调用方开关) ──
	const stopSubagents = options.subagents === true ? startSubagentConsumer({ db }) : () => undefined;
	const stopAutomation = startAutomationScheduler({
		db,
		store,
		runtime: options.runtime,
		streamFn: options.streamFn,
		config: {
			enabled: options.automation === true && config.automationEnabled,
			morningDigestTime: config.morningDigestTime,
			weeklyReportWeekday: config.weeklyReportWeekday,
			weeklyReportTime: config.weeklyReportTime,
			silentCustomerDays: config.silentCustomerDays,
			silentWakeupEnabled: config.silentWakeupEnabled,
			wakeupTaskTime: config.wakeupTaskTime,
		},
	});

	app.addHook("onClose", async () => {
		stopWeixin();
		stopMcpWarmup();
		stopSubagents();
		stopAutomation();
		await Promise.allSettled([store.close(), reminders.close(), closeStopSignal()]);
		db.close();
	});

	return app;
}
