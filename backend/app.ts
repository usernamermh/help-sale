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
import { tenantExists } from "./integrations_pi/tables/crm/customers.js";
import { resolveIdentity } from "./services/auth.js";
import { countAdmins, createUser } from "./integrations_pi/tables/agents/users.js";
import { countPlatformAdmins, createPlatformAdmin } from "./integrations_pi/tables/agents/platform-admins.js";
import { withTenantGuard } from "./db/tenant-guard.js";
import { assertTableMappingComplete } from "./db/schema-audit.js";
import { createTenantQuota } from "./services/tenant-quota.js";
import { createQuotaLimitResolver } from "./services/tenant-quota-limits.js";
import { createSyncMysqlDb } from "./db/mysql/client.js";
import { createReminderQueue, type ReminderQueue } from "./integrations_db/reminder-queue.js";
import { closeStopSignal, initStopSignal } from "./services/stop-signal.js";
import { appendRuntimeLog } from "./services/runtime-log.js";
import { startAutomationScheduler } from "./services/routes/automation.js";
import { startSubagentConsumer } from "./services/routes/agent/index.js";
import { SUBAGENT_WAKE_CHANNEL } from "./services/routes/agent/runner.js";
import { setSubagentWakePublisher } from "./services/routes/agent/subagent-signal.js";
import { createClusterCoordinator } from "./integrations_db/cluster.js";

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
/** 免登录路径:登录入口、健康检查与静态页(其余业务接口在 auth.enabled=true 时必须带令牌或 API Key)。 */
export function isAuthExemptPath(url: string): boolean {
	const path = String(url ?? "").split("?")[0];
	if (path === "/api/v1/auth/login") return true;
	if (path === "/api/v1/platform/login") return true;
	if (path === "/api/v1/health" || path === "/api/v1/ready") return true;
	if (path === "/" || path === "/console" || path === "/platform") return true;
	if (path.startsWith("/vendor/")) return true;
	return false;
}

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
	// 表映射自检:schema 里的表必须都在 data.tables 里(否则租户守卫不会覆盖那张表)
	const mappingAudit = assertTableMappingComplete(config.tables);
	console.log(`[config] 表映射自检通过:${mappingAudit.schemaTables.length} 张表全部纳入租户守卫${mappingAudit.extraKeys.length > 0 ? `(另有自定义表 ${mappingAudit.extraKeys.join(", ")})` : ""}`);

	const rawDb: DatabaseSync =
		options.dataDir || config.dataMode !== "mysql" ? openDatabase(businessDbPath) : (createSyncMysqlDb() as unknown as DatabaseSync);
	// 租户隔离强制点:业务表语句缺 tenant_id 谓词时按配置告警或直接拦下(MySQL 没有 RLS,这里做应用层强制)
	const db: DatabaseSync = config.tenantDataIsolationMode === "off"
		? rawDb
		: withTenantGuard(rawDb, { tables: config.tables, mode: config.tenantDataIsolationMode });
	const store = openSessionStore(dataDir, sessionDbPath);

	if (options.ensureTenant !== false) requireTenant(db, config.tenantId, "示例租户");
	if (options.ensureTenant !== false && config.authEnabled) {
		// 平台(总部)管理员:密钥文件里的初始账号,幂等创建
		if (countPlatformAdmins(db) === 0) {
			createPlatformAdmin(db, { username: config.authPlatformUsername, password: config.authPlatformPassword });
			console.log(`[auth] 已创建平台管理员:${config.authPlatformUsername}(密码取自密钥文件,登录后请立即修改)`);
		}
		requireTenant(db, config.authBootstrapTenantId, "初始管理员租户");
		if (countAdmins(db, config.authBootstrapTenantId) === 0) {
			createUser(db, { tenantId: config.authBootstrapTenantId, username: config.authBootstrapUsername, password: config.authBootstrapPassword, role: "admin" });
			console.log(`[auth] 已创建初始管理员:${config.authBootstrapUsername}@${config.authBootstrapTenantId}(密码取自密钥文件,登录后请立即修改)`);
		}
	}

	app.decorateRequest("tenantId", "");
	app.decorateRequest("tenantRole", undefined);
	app.decorateRequest("tenantUserId", undefined);
	app.decorateRequest("platformAdmin", undefined);
	app.decorateRequest("platformAdminId", undefined);
	// 租户不再由调用方随意声明:凭证(API Key)优先,请求头只在配置允许时才认,且要落在受信清单内
	app.addHook("preHandler", async (request, reply) => {
		const headers = request.headers as Record<string, string | string[] | undefined>;
		// 登录令牌优先:令牌里的租户是权威的,并且带着角色(admin/member)
		const authExempt = isAuthExemptPath(request.url);
		const identity = config.authEnabled ? resolveIdentity(db, headers, { enabled: true, tokenTtlHours: config.authTokenTtlHours, tokenSecret: config.authTokenSecret }) : { hasToken: false as const };
		if (identity.identity) {
			if (identity.identity.scope === "platform") {
				// 平台令牌不带租户:只放行平台层接口,其它一律 403(避免"总部身份顺手读某个门店")
				if (!request.url.startsWith("/api/v1/platform/")) {
					return reply.code(403).send({ error: "forbidden", message: "平台令牌只能访问 /api/v1/platform/* 接口。" });
				}
				request.tenantId = "";
				request.platformAdmin = true;
				request.platformAdminId = identity.identity.userId;
			} else {
				request.tenantId = identity.identity.tenantId;
				request.tenantRole = identity.identity.role;
				request.tenantUserId = identity.identity.userId;
			}
		} else {
			if (identity.error) {
				appendRuntimeLog(logDir, { level: "error", type: "tenant_rejected", message: `${request.method} ${request.url} 令牌校验失败: ${identity.error}` }, { fileName: config.logRuntimeFile, level: config.logLevel, maxBytes: config.logMaxBytes });
				return reply.code(401).send({ error: "unauthenticated", message: identity.error });
			}
			if (authExempt) {
				// 登录/健康检查:门店是平台动态开的,不受 tenant.trustedTenantIds 这份静态清单限制(业务接口一律按令牌里的租户走);这里只取请求头声明的门店,没写就用默认租户
				const rawHeader = headers["x-tenant-id"];
				const fromHeader = String(Array.isArray(rawHeader) ? rawHeader[0] ?? "" : rawHeader ?? "").trim();
				request.tenantId = fromHeader || config.tenantId;
			} else {
				const resolved = resolveTenant({ headers, apiKeys: config.tenantApiKeys, headerAllowed: config.tenantHeaderAllowed, defaultTenantId: config.tenantId });
				if (resolved.error) {
					appendRuntimeLog(logDir, { level: "error", type: "tenant_rejected", message: `${request.method} ${request.url} 租户校验失败: ${resolved.error.message}`, meta: { tenantHeader: (request.headers["x-tenant-id"] as string | undefined) ?? null } }, { fileName: config.logRuntimeFile, level: config.logLevel, maxBytes: config.logMaxBytes });
					return reply.code(resolved.error.status).send({ error: "tenant_not_allowed", message: resolved.error.message });
				}
				// 开启登录后:只有集成方 API Key 能免登录,请求头/默认租户不足以进入业务接口
				if (config.authEnabled && resolved.source !== "api-key") {
					return reply.code(401).send({ error: "unauthenticated", message: "请先登录(Authorization: Bearer <token>),或使用集成方 API Key(x-api-key)。" });
				}
				// 受信 = 库里已有的门店:请求头声明的门店必须真实存在(门店由平台动态开,没有静态清单)
				if (resolved.source === "header" && resolved.tenantId && !tenantExists(db, resolved.tenantId)) {
					appendRuntimeLog(logDir, { level: "error", type: "tenant_rejected", message: request.method + " " + request.url + " 门店不存在: " + resolved.tenantId }, { fileName: config.logRuntimeFile, level: config.logLevel, maxBytes: config.logMaxBytes });
					return reply.code(403).send({ error: "tenant_not_allowed", message: "门店不存在:" + resolved.tenantId });
				}
				request.tenantId = resolved.tenantId ?? config.tenantId;
				request.tenantRole = resolved.source === "api-key" ? "member" : undefined;
			}
		}
		// 每租户请求限流:超出的请求立刻拒绝,不占用共享资源(单租户刷量不影响其他租户)
		const gate = await quota.tryAcquireRequest(request.tenantId || "platform");
		if (!gate.allowed) {
			appendRuntimeLog(logDir, {
				level: "error",
				type: "tenant_throttled",
				message: `${request.method} ${request.url} 触发租户限流(建议 ${Math.ceil(gate.retryAfterMs / 1000)}s 后重试)`,
				meta: { tenantId: request.tenantId },
			}, { fileName: config.logRuntimeFile, level: config.logLevel, maxBytes: config.logMaxBytes });
			reply.header("Retry-After", String(Math.ceil(gate.retryAfterMs / 1000)));
			return reply.code(429).send({ error: "tenant_rate_limited", message: `请求过于频繁,请 ${Math.ceil(gate.retryAfterMs / 1000)} 秒后重试`, retryAfterMs: gate.retryAfterMs });
		}
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

	// 每租户额度:请求令牌桶 + agent 并发槽位(Redis 可用则跨实例共享)
	const quota = createTenantQuota({
		enabled: config.tenantRateLimitEnabled,
		requestPerMinute: config.tenantRequestPerMinute,
		requestBurst: config.tenantRequestBurst,
		agentConcurrency: config.tenantAgentConcurrency,
		retryAfterSeconds: config.tenantRetryAfterSeconds,
		redis: { enabled: config.redisEnabled, host: config.redisHost, port: config.redisPort, password: config.redisPassword },
		// 门店级额度:平台写进 tenant_secrets 的 quota.* 覆盖全局(5 秒缓存,配完很快生效)
		resolveLimits: createQuotaLimitResolver(db),
	});
	const deps: RouteDeps = { db, store, dataDir, logDir, runtime: options.runtime, streamFn: options.streamFn, reminders, quota };

	// ── 多实例协调(Redis 可用才支持多实例) ──
	const cluster = createClusterCoordinator({
		enabled: config.redisEnabled,
		host: config.redisHost,
		port: config.redisPort,
		password: config.redisPassword,
		leaderLeaseMs: config.redisLeaderLeaseMs,
	});
	console.log(
		cluster.redisEnabled
			? `[cluster] Redis 可用:支持多实例部署(主实例锁选主,跨实例唤醒);本实例 ${cluster.instanceId}`
			: `[cluster] Redis 未启用:后台任务为进程内模式,仅支持单实例部署;本实例 ${cluster.instanceId}`,
	);
	// 建卡时除了唤醒本进程,还广播给其他实例
	setSubagentWakePublisher((message) => cluster.publish(SUBAGENT_WAKE_CHANNEL, message));

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
	const stopWeixin = registerWeixin(app, { db, dataDir, store, runtime: options.runtime, streamFn: options.streamFn, quota, isLeader: (tenantId: string) => cluster.isLeader("weixin-poller:" + tenantId) });

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
		html.split("__CLIENT_CONFIG__").join(JSON.stringify({ tenantId: config.tenantId, workflowMineTimeoutMs: config.workflowMineTimeoutMs, authEnabled: config.authEnabled }));
	const injectTenant = (html: string) => html.split("__APP_TENANT_ID__").join(JSON.stringify(config.tenantId));
	const CLIENT_FUNC_FILES = ["base.js", "charts.js", "origin_dialog.js", "subagents_record.js", "current_turn_record.js", "function_supports.js", "history_dialogs.js", "keywords_manager.js", "ontime_tasks.js", "workflow.js", "live_updates.js", "init.js"];
	const clientFuncsHtml = () =>
		CLIENT_FUNC_FILES.map((f) => "<script>\n" + readFileSync(path.join(frontDir, "client_functions", f), "utf8") + "\n</script>").join("\n");
	const renderClient = () =>
		injectClientConfig(injectTenant(readFileSync(path.join(frontDir, "client.html"), "utf8").replace("<!--CLIENT_FUNCTIONS-->", clientFuncsHtml())));

	app.get("/", async (_request, reply) => {
		reply.header("Cache-Control", "no-store").type("text/html; charset=utf-8").send(renderClient());
	});
	// 总部平台页:开门店、看各店登录状态、重置门店管理员、清门店(登录用平台账号)
	app.get("/platform", async (_request, reply) => {
		reply.header("Cache-Control", "no-store").type("text/html; charset=utf-8").send(readFileSync(path.join(frontDir, "platform.html"), "utf8"));
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

	// 申请"单例任务"的主实例锁(拿不到就等待别人释放;拿到后定时任务与微信长轮询才开始工作)
	cluster.watchLeadership("automation", () => undefined);
	cluster.watchLeadership("weixin-poller", () => undefined);

	// ── 后台常驻任务:定时自动化 + 子代理消费者(按配置与调用方开关) ──
	const stopSubagents = options.subagents === true ? startSubagentConsumer({ db, cluster }) : () => undefined;
	const stopAutomation = startAutomationScheduler({
		db,
		store,
		runtime: options.runtime,
		streamFn: options.streamFn,
		isLeader: () => cluster.isLeader("automation"),
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
		await cluster.close();
		await quota.close();
		await Promise.allSettled([store.close(), reminders.close(), closeStopSignal()]);
		db.close();
	});

	return app;
}
