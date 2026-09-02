import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { openDatabase } from "./db/database.js";
import { loadConfig } from "./env.js";
import { openSessionStore } from "./pi/sessions.js";
import { requireTenant } from "./repositories/customers.js";
import type { ModelRuntime } from "./pi/models.js";
import { registerRoutes } from "./routes.js";
import { createMysqlSink, type MysqlSink } from "./integrations/mysql-sink.js";
import { createReminderQueue, type ReminderQueue } from "./integrations/reminder-queue.js";
import { seedVehicles } from "./services/seed.js";

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
	const config = loadConfig();
	const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
	const apiRoot = path.join(repoRoot, "apps", "api");
	const configured = options.dataDir ?? config.dataDir;
	const dataDir = path.isAbsolute(configured) ? configured : path.join(repoRoot, configured);
	mkdirSync(dataDir, { recursive: true });

	const businessDbPath = path.join(dataDir, "business.db");
	const sessionDbPath = path.join(dataDir, "pi-sessions.db");
	const db = openDatabase(businessDbPath);
	const store = openSessionStore(dataDir, sessionDbPath);

	// 为默认租户播种示例车型(车型优选开箱即用;测试/定制可传 false 或指定租户)
	if (options.seedVehiclesFor !== false) {
		const targets = options.seedVehiclesFor ?? [config.tenantId];
		for (const tenantId of targets) requireTenant(db, tenantId, "示例租户");
		seedVehicles(db, targets);
	}

	app.decorateRequest("tenantId", "");
	app.addHook("preHandler", async (request) => {
		request.tenantId = (request.headers["x-tenant-id"] as string | undefined) ?? config.tenantId;
	});

	const mysqlSink = options.mysqlSink ?? createMysqlSink({
		enabled: config.mysqlEnabled,
		host: config.mysqlHost,
		port: config.mysqlPort,
		user: config.mysqlUser,
		password: config.mysqlPassword,
		database: config.mysqlDatabase,
	});
	const reminders = options.reminders ?? createReminderQueue({
		enabled: config.redisEnabled,
		host: config.redisHost,
		port: config.redisPort,
		password: config.redisPassword,
	});

	registerRoutes(app, { db, store, runtime: options.runtime, streamFn: options.streamFn, mysqlSink, reminders });

	// 前端单页工具:根路径返回内嵌页面
	const pagePath = path.join(apiRoot, "public", "index.html");
	app.get("/", async (_request, reply) => {
		reply.type("text/html; charset=utf-8").send(readFileSync(pagePath, "utf8"));
	});

	app.addHook("onClose", async () => {
		const closeTasks: Promise<void>[] = [store.close(), mysqlSink.close(), reminders.close()];
		await Promise.allSettled(closeTasks);
		db.close();
	});

	return app;
}