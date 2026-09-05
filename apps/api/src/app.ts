import type { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { openDatabase } from "./db/database.js";
import { config } from "./env.js";
import { openSessionStore } from "./pi/sessions.js";
import { requireTenant } from "./repositories/customers.js";
import type { ModelRuntime } from "./pi/models.js";
import { registerRoutes } from "./routes.js";
import { createMysqlSink, type MysqlSink } from "./integrations/mysql-sink.js";
import { createSyncMysqlDb } from "./db/mysql/client.js";
import { createReminderQueue, type ReminderQueue } from "./integrations/reminder-queue.js";
import { seedStoreData, seedVehicles } from "./services/seed.js";
import { appendRuntimeLog } from "./services/runtime-log.js";

declare module "fastify" {
	interface FastifyRequest {
		tenantId: string;
	}
}

export interface AppOptions {
	logger?: boolean;
	dataDir?: string;
	runtime?: ModelRuntime;
	streamFn?: StreamFn;
	seedVehiclesFor?: string[] | false;
	mysqlSink?: MysqlSink;
	reminders?: ReminderQueue;
}

export function buildApp(options: AppOptions = {}): FastifyInstance {
	const app = Fastify({ logger: options.logger ?? false });


	const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
	const apiRoot = path.join(repoRoot, "apps", "api");
	const configured = options.dataDir ?? config.dataDir;
	const dataDir = path.isAbsolute(configured) ? configured : path.join(repoRoot, configured);
	mkdirSync(dataDir, { recursive: true });

	// 数据库路径默认来自配置文件(businessDbPath/sessionDbPath);测试显式指定 dataDir 时仍落在临时目录
	const resolveDbPath = (p: string) => (path.isAbsolute(p) ? p : path.join(repoRoot, p));
	const businessDbPath = options.dataDir ? path.join(dataDir, "business.db") : resolveDbPath(config.businessDbPath);
	const sessionDbPath = options.dataDir ? path.join(dataDir, "pi-sessions.db") : resolveDbPath(config.sessionDbPath);
	// 数据存储二选一:local = SQLite 业务库;mysql = 远程 MySQL 业务库(同步桥,仓库层零改动)
	// 注:pi 会话库(sessionDbPath)为本地运行态存储,仅记录 agent 会话;业务数据全部在所选模式数据库
	const db: DatabaseSync =
		config.dataMode === "mysql" ? (createSyncMysqlDb() as unknown as DatabaseSync) : openDatabase(businessDbPath);
	const store = openSessionStore(dataDir, sessionDbPath);

	// 为默认租户播种示例车型与门店经营数据(门店/店长/销售/客户/会话原文/成交;测试/定制可传 false 或指定租户)
	if (options.seedVehiclesFor !== false) {
		const targets = options.seedVehiclesFor ?? [config.tenantId];
		for (const tenantId of targets) requireTenant(db, tenantId, "示例租户");
		seedVehicles(db, targets);
		seedStoreData(db, targets);
	}

	app.decorateRequest("tenantId", "");
	app.addHook("preHandler", async (request) => {
		request.tenantId = (request.headers["x-tenant-id"] as string | undefined) ?? config.tenantId;
	});

	// local 单一存储:默认不启用 MySQL 归档双写(测试可通过 options.mysqlSink 注入观察器)
	const mysqlSink = options.mysqlSink ?? undefined;
	const reminders = options.reminders ?? createReminderQueue({
		enabled: config.redisEnabled,
		host: config.redisHost,
		port: config.redisPort,
		password: config.redisPassword,
	});

	registerRoutes(app, { db, store, dataDir, runtime: options.runtime, streamFn: options.streamFn, mysqlSink, reminders });

	app.addHook("onResponse", async (request, reply) => {
		if (request.url.startsWith("/api/")) {
			appendRuntimeLog(dataDir, {
				level: "info",
				type: "request",
				message: `${request.method} ${request.url} -> ${reply.statusCode}`,
				meta: { tenantId: request.tenantId, elapsedMs: reply.elapsedTime },
			});
		}
	});
	app.addHook("onError", async (request, reply, error) => {
		appendRuntimeLog(dataDir, {
			level: "error",
			type: "error",
			message: `${request.method} ${request.url} -> ${reply.statusCode}: ${error.message}`,
			meta: { tenantId: request.tenantId, stack: error.stack },
		});
	});

	// 前端单页工具:根路径返回内嵌页面
	const clientPath = path.join(apiRoot, "public", "client.html");
	const consolePath = path.join(apiRoot, "public", "console.html");
	const legacyPath = path.join(apiRoot, "public", "index.html");
	app.get("/", async (_request, reply) => {
		reply.header("Cache-Control", "no-store").type("text/html; charset=utf-8").send(readFileSync(clientPath, "utf8"));
	});
	app.get("/console", async (_request, reply) => {
		reply.header("Cache-Control", "no-store").type("text/html; charset=utf-8").send(readFileSync(consolePath, "utf8"));
	});
	app.get("/workspace", async (_request, reply) => {
		reply.header("Cache-Control", "no-store").type("text/html; charset=utf-8").send(readFileSync(legacyPath, "utf8"));
	});

	app.get<{ Params: { file: string } }>("/vendor/:file", async (request, reply) => {
		const name = request.params.file;
		if (!/^[\w.-]+\.js$/.test(name)) return reply.code(404).send({ error: "not_found" });
		try {
			const filePath = path.join(apiRoot, "public", "vendor", name);
			return reply.type("text/javascript; charset=utf-8").send(readFileSync(filePath, "utf8"));
		} catch {
			return reply.code(404).send({ error: "not_found" });
		}
	});

	app.addHook("onClose", async () => {
		const closeTasks: Array<Promise<void> | undefined> = [store.close(), mysqlSink?.close(), reminders.close()];
		await Promise.allSettled(closeTasks);
		db.close();
	});

	return app;
}