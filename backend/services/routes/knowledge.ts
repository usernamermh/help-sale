// knowledge 域路由(由 v1 routes/list_for_view.ts 拆分而来)
import type { FastifyInstance } from "fastify";
import { listCandidates, approveCandidate, rejectCandidate, reviewCandidate } from "../../integrations_pi/tables/knowledge/candidates.js";
import { config } from "../../env.js";
import { type RouteDeps } from "./helpers.js";

export function registerKnowledgeRoutes(app: FastifyInstance, deps: RouteDeps): void {
app.get<{ Querystring: { status?: string } }>("/api/v1/knowledge/candidates", async (request) => {
		const status = request.query.status as "pending" | "approved" | "rejected" | undefined;
		const candidates = listCandidates(deps.db, request.tenantId, status, config.knowledgeCandidatesLimit);
		// 二次确认(检索 + 相似度 → 新增/覆盖/跳过建议)此前只在 approve 时惰性补做,
		// 导致审批列表里永远看不到建议。这里对 pending 条目后台补做,不阻塞本次返回。
		for (const c of candidates) {
			if (c.status !== "pending" || c.suggestAction) continue;
			void reviewCandidate(deps.db, request.tenantId, c.id).catch((error) => {
				console.warn(`[knowledge] 候选二次确认失败(${c.id}):`, error instanceof Error ? error.message : String(error));
			});
		}
		return { candidates };
	});

app.post<{ Params: { id: string } }>("/api/v1/knowledge/candidates/:id/approve", async (request, reply) => {
		const candidate = await approveCandidate(deps.db, request.tenantId, request.params.id);
		if (!candidate) return reply.code(404).send({ error: "candidate_not_found", message: "候选不存在" });
		return { candidate };
	});

app.post<{ Params: { id: string } }>("/api/v1/knowledge/candidates/:id/reject", async (request, reply) => {
		const candidate = rejectCandidate(deps.db, request.tenantId, request.params.id);
		if (!candidate) return reply.code(404).send({ error: "candidate_not_found", message: "候选不存在" });
		return { candidate };
	});
}
