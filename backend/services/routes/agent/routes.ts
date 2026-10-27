// Agent 协作域 HTTP 路由(由 v1 routes/list_for_view.ts 拆分而来)
import type { FastifyInstance } from "fastify";
import type { RouteDeps } from "../helpers.js";
import { listKanbanCards } from "./kanban.js";
import { consumeKanbanSubagents } from "./runner.js";

export function registerAgentRoutes(app: FastifyInstance, deps: RouteDeps): void {
app.get<{ Querystring: { threadId?: string } }>("/api/v1/kanban", async (request) => {
		const threadId = request.query.threadId ? String(request.query.threadId) : undefined;
		return { cards: listKanbanCards(deps.db, request.tenantId, { threadId }) };
	});

app.get<{ Querystring: { status?: string } }>("/api/v1/subagents", async (request) => {
		const status = request.query.status === "pending" || request.query.status === "inprogress" || request.query.status === "done" || request.query.status === "error" ? request.query.status : undefined;
		return { tasks: listKanbanCards(deps.db, request.tenantId, { status }) };
	});

app.post("/api/v1/subagents/run", async (request) => {
		const executed = await consumeKanbanSubagents({ db: deps.db }, request.tenantId, { limit: 2 });
		return { executed };
	});
}
