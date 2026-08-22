import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { openDatabase } from "./db/database.js";
import { loadConfig } from "./env.js";
import { openSessionStore } from "./pi/sessions.js";
import type { ModelRuntime } from "./pi/models.js";
import { registerRoutes } from "./routes.js";

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

	app.decorateRequest("tenantId", "");
	app.addHook("preHandler", async (request) => {
		request.tenantId = (request.headers["x-tenant-id"] as string | undefined) ?? config.tenantId;
	});

	registerRoutes(app, { db, store, runtime: options.runtime, streamFn: options.streamFn });

	// 前端单页工具:根路径返回内嵌页面
	const pagePath = path.join(apiRoot, "public", "index.html");
	app.get("/", async (_request, reply) => {
		reply.type("text/html; charset=utf-8").send(readFileSync(pagePath, "utf8"));
	});

	app.addHook("onClose", async () => {
		await store.close();
		db.close();
	});

	return app;
}