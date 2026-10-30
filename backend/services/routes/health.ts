import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { config } from "../../env.js";

/**
 * 健康检查分两个:
 *   /api/v1/health  liveness —— 进程活着就返回 ok(启动脚本/容器探针用,不查依赖)
 *   /api/v1/ready   readiness —— 真查一遍依赖(业务库、Redis、模型网关),任一不可用返回 503
 */

export interface HealthRouteDeps {
	db: DatabaseSync;
}

interface CheckResult {
	ok: boolean;
	ms: number;
	detail?: string;
}

async function withTiming(run: () => Promise<string | undefined>): Promise<CheckResult> {
	const startedAt = Date.now();
	try {
		const detail = await run();
		return { ok: true, ms: Date.now() - startedAt, detail };
	} catch (error) {
		return { ok: false, ms: Date.now() - startedAt, detail: error instanceof Error ? error.message : String(error) };
	}
}

function checkDatabase(db: DatabaseSync): Promise<CheckResult> {
	return withTiming(async () => {
		db.prepare("SELECT 1 AS ok").get();
		return undefined;
	});
}

function checkRedis(): Promise<CheckResult> {
	if (!config.redisEnabled) return Promise.resolve({ ok: true, ms: 0, detail: "未启用,跳过" });
	return withTiming(async () => {
		const { Redis } = await import("ioredis");
		const client = new Redis({
			host: config.redisHost,
			port: config.redisPort,
			password: config.redisPassword || undefined,
			lazyConnect: true,
			connectTimeout: 2000,
			maxRetriesPerRequest: 1,
			retryStrategy: () => null,
		});
		try {
			await client.connect();
			const pong = await client.ping();
			return pong === "PONG" ? undefined : `返回 ${pong}`;
		} finally {
			client.disconnect();
		}
	});
}

/** 模型网关:能建连并收到任何 HTTP 响应就算可达(401/404 也算通,只是没权限/没这个路径)。 */
function checkModel(): Promise<CheckResult> {
	return withTiming(async () => {
		const base = config.modelBaseUrl.replace(/\/+$/, "");
		const response = await fetch(`${base}/models`, {
			method: "GET",
			headers: config.modelApiKey ? { Authorization: `Bearer ${config.modelApiKey}` } : {},
			signal: AbortSignal.timeout(3000),
		});
		return `HTTP ${response.status}`;
	});
}

export function registerHealthRoutes(app: FastifyInstance, deps: HealthRouteDeps): void {
	app.get("/api/v1/health", async () => ({ status: "ok", ts: Date.now() }));

	app.get("/api/v1/ready", async (_request, reply) => {
		const [db, redis, model] = await Promise.all([checkDatabase(deps.db), checkRedis(), checkModel()]);
		const checks = { db, redis, model };
		const ready = db.ok && redis.ok && model.ok;
		const payload = {
			status: ready ? "ready" : "degraded",
			ts: Date.now(),
			dataMode: config.dataMode,
			checks,
		};
		return reply.code(ready ? 200 : 503).send(payload);
	});
}