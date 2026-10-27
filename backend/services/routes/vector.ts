// vector 域路由(由 v1 routes/list_for_view.ts 拆分而来)
import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { countLocalVectors, flushVectorQueue, milvusReachable, reindexAll, searchSimilarChunks } from "../vector-store.js";
import { countVectors, milvusEnabled } from "../milvus.js";
import { config } from "../../env.js";
import { type RouteDeps } from "./helpers.js";

export function registerVectorRoutes(app: FastifyInstance, deps: RouteDeps): void {
app.get("/api/v1/knowledge/vector-status", async (request) => {
		const unindexed = db_scalar(deps.db, `SELECT COUNT(*) AS n FROM knowledge_chunks kc WHERE kc.tenant_id = ? AND kc.id NOT IN (SELECT chunk_id FROM knowledge_embeddings WHERE tenant_id = ?)`, [request.tenantId, request.tenantId]);
		const remote = milvusEnabled() ? await milvusReachable() : false;
		return {
			enabled: milvusEnabled(),
			provider: config.vectorProvider,
			baseUrl: config.vectorBaseUrl,
			collection: config.vectorCollection,
			reachable: remote,
			localVectors: countLocalVectors(deps.db, request.tenantId),
			remoteVectors: remote ? await countVectors(request.tenantId) : null,
			unindexedChunks: unindexed,
			note: remote ? null : "Milvus 未启用或不可达,语义检索走本地向量兜底(FTS5 关键词检索不受影响)",
		};
	});

	// 全量重建:补齐"本地没有向量的分块"(首次接入 Milvus / 历史数据 / 索引失败后补救)

app.post<{ Body: { limit?: number } }>("/api/v1/knowledge/vector-reindex", async (request) => {
		const limit = Math.max(1, Math.min(Number(request.body?.limit ?? 200) || 200, 2000));
		await flushVectorQueue(deps.db);
		const result = await reindexAll(deps.db, request.tenantId, limit);
		await flushVectorQueue(deps.db);
		return { ...result, remaining: db_scalar(deps.db, `SELECT COUNT(*) AS n FROM knowledge_chunks kc WHERE kc.tenant_id = ? AND kc.id NOT IN (SELECT chunk_id FROM knowledge_embeddings WHERE tenant_id = ?)`, [request.tenantId, request.tenantId]) };
	});

	// 语义检索预览:验证"这句话会命中哪些话术",便于排查阈值与索引问题

app.get<{ Querystring: { q?: string; topK?: string; threshold?: string; category?: string } }>("/api/v1/knowledge/semantic-search", async (request, reply) => {
		const q = String(request.query.q ?? "").trim();
		if (!q) return reply.code(400).send({ error: "q is required" });
		const topK = Math.max(1, Math.min(Number(request.query.topK ?? 5) || 5, 20));
		const threshold = Number(request.query.threshold ?? config.vectorScoreThreshold);
		const category = request.query.category ? String(request.query.category) : undefined;
		await flushVectorQueue(deps.db);
		const hits = await searchSimilarChunks(deps.db, request.tenantId, q, { topK, scoreThreshold: threshold, category });
		const rows = hits.map((h) => {
			const row = db_row(deps.db, "SELECT kc.content, kd.title, kd.category FROM knowledge_chunks kc JOIN knowledge_documents kd ON kd.id = kc.document_id WHERE kc.id = ? AND kc.tenant_id = ?", [h.chunkId, request.tenantId]) as { content: string; title: string; category: string | null } | undefined;
			return row ? { chunkId: h.chunkId, score: Number(h.score.toFixed(4)), title: row.title, category: row.category, snippet: row.content.slice(0, 120) } : null;
		}).filter(Boolean);
		return { query: q, threshold, hits: rows, backend: milvusEnabled() ? "milvus-or-local-fallback" : "local" };
	});
}

/** 取单个计数列(列名未知时用键取第一个值)。 */
function db_scalar(db: DatabaseSync, sql: string, params: Array<string | number>): number {
	const row = db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
	if (!row) return 0;
	return Number(Object.values(row)[0] ?? 0);
}
function db_row(db: DatabaseSync, sql: string, params: Array<string | number>): unknown {
	return db.prepare(sql).get(...params);
}
