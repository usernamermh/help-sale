import type { FastifyInstance } from "fastify";

/** 健康检查:供启动脚本/容器探针使用(不查库,只确认进程已就绪)。 */
export function registerHealthRoutes(app: FastifyInstance): void {
	app.get("/api/v1/health", async () => ({ status: "ok", ts: Date.now() }));
}
