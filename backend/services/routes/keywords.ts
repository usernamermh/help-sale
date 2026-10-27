// keywords 域路由(由 v1 routes/list_for_view.ts 拆分而来)
import type { FastifyInstance } from "fastify";
import { listKeywordCategories, listKeywords, upsertKeyword, updateKeyword, deleteKeyword } from "../../integrations_pi/tables/knowledge/keywords.js";
import { buildCategoryTree, createCategory, deleteCategory, renameCategory } from "../../integrations_pi/tables/knowledge/keyword-categories.js";
import { listKeywordHits } from "../../integrations_pi/tables/knowledge/keyword-hits.js";
import { type RouteDeps } from "./helpers.js";

export function registerKeywordRoutes(app: FastifyInstance, deps: RouteDeps): void {
app.get("/api/v1/keywords", async (request) => {
		const q = request.query as { categoryL1?: string; categoryL2?: string; categoryL3?: string; categoryPaths?: string | string[]; keyword?: string; page?: string; pageSize?: string };
		const rawPaths = Array.isArray(q.categoryPaths) ? q.categoryPaths : q.categoryPaths ? [q.categoryPaths] : [];
		const page = listKeywords(deps.db, request.tenantId, {
			categoryL1: q.categoryL1,
			categoryL2: q.categoryL2,
			categoryL3: q.categoryL3,
			categoryPaths: rawPaths.filter(Boolean) as string[],
			keyword: q.keyword,
			page: q.page ? Number(q.page) : undefined,
			pageSize: q.pageSize ? Number(q.pageSize) : undefined,
		});
		return { keywords: page.items, total: page.total, page: page.page, pageSize: page.pageSize, totalPages: page.totalPages };
	});

app.get("/api/v1/keywords/categories", async (request) => {
		return listKeywordCategories(deps.db, request.tenantId);
	});

app.get("/api/v1/keyword-categories/tree", async (request) => {
		return { tree: buildCategoryTree(deps.db, request.tenantId) };
	});

app.post("/api/v1/keyword-categories", async (request, reply) => {
		const body = (request.body ?? {}) as { name?: string; parentId?: string; level?: number };
		if (!body.name?.trim()) return reply.code(400).send({ error: "name is required" });
		try {
			const cat = createCategory(deps.db, request.tenantId, { name: body.name, parentId: body.parentId, level: body.level });
			return { category: cat };
		} catch (error) {
			return reply.code(400).send({ error: error instanceof Error ? error.message : "create_failed" });
		}
	});

app.put<{ Params: { id: string } }>("/api/v1/keyword-categories/:id", async (request, reply) => {
		const body = (request.body ?? {}) as { name?: string; parentId?: string | null };
		try {
			const cat = renameCategory(deps.db, request.tenantId, request.params.id, {
				name: body.name,
				parentId: body.parentId === undefined ? undefined : (body.parentId || null),
			});
			if (!cat) return reply.code(404).send({ error: "category_not_found" });
			return { category: cat };
		} catch (error) {
			return reply.code(400).send({ error: error instanceof Error ? error.message : "update_failed" });
		}
	});

app.delete<{ Params: { id: string } }>("/api/v1/keyword-categories/:id", async (request, reply) => {
		const ok = deleteCategory(deps.db, request.tenantId, request.params.id);
		if (!ok) return reply.code(404).send({ error: "category_not_found" });
		return { removed: true };
	});

app.post("/api/v1/keywords", async (request, reply) => {
		const body = (request.body ?? {}) as { keyword?: string; category?: string; categoryL1?: string; categoryL2?: string; categoryL3?: string };
		if (!body.keyword?.trim()) return reply.code(400).send({ error: "keyword is required" });
		const k = upsertKeyword(deps.db, request.tenantId, { keyword: body.keyword, category: body.category, categoryL1: body.categoryL1, categoryL2: body.categoryL2, categoryL3: body.categoryL3, source: "manual" });
		return { keyword: k };
	});

app.put<{ Params: { id: string } }>("/api/v1/keywords/:id", async (request, reply) => {
		const body = (request.body ?? {}) as { keyword?: string; category?: string; categoryL1?: string; categoryL2?: string; categoryL3?: string };
		const k = updateKeyword(deps.db, request.tenantId, request.params.id, body);
		if (!k) return reply.code(404).send({ error: "keyword_not_found" });
		return { keyword: k };
	});

app.delete<{ Params: { id: string } }>("/api/v1/keywords/:id", async (request, reply) => {
		const ok = deleteKeyword(deps.db, request.tenantId, request.params.id);
		if (!ok) return reply.code(404).send({ error: "keyword_not_found" });
		return { removed: true };
	});

	// ── 工作流 ──
	// 挖掘:轨迹高频串联 → LLM 提炼 → 工具存在性校验 → 签名去重 → 落草稿(等待人工晋升)

app.get<{ Params: { id: string } }>("/api/v1/keywords/:id/hits", async (request) => {
		return { hits: listKeywordHits(deps.db, request.tenantId, request.params.id) };
	});
}
