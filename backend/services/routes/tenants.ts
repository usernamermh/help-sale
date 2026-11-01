/**
 * 租户管理面(仅管理员):列表、新建、改名、导出、清除。
 *
 * 这些接口天然是跨租户操作,所以每条语句都显式带 /* system *​/ 标记(守卫要求"故意写"),
 * 且整体走 requireAdmin —— 开启登录后只有 admin 角色能用。
 */
import type { FastifyInstance } from "fastify";
import { config } from "../../env.js";
import { requireAdmin, type RouteDeps } from "./helpers.js";
import { removeChunkVectors } from "../vector-store.js";

/** 租户表的物理表名(listTenantIds 用)。 */
function tenantTable(): string {
	return config.tables.tenants ?? "tenants";
}

interface TenantRow {
	id: string;
	name: string;
	slug: string;
	createdAt: string;
}

function listTenantRows(db: RouteDeps["db"]): TenantRow[] {
	const rows = db.prepare(`/* system */ SELECT id, name, slug, created_at FROM ${tenantTable()} ORDER BY created_at, id`).all() as Array<Record<string, unknown>>;
	return rows.map((row) => ({ id: String(row.id), name: String(row.name ?? ""), slug: String(row.slug ?? ""), createdAt: row.created_at ? String(row.created_at) : "" }));
}

/** 每个租户一张业务表的行数:一次 group by 拿全量,避免按租户逐个 COUNT。 */
function tenantRowCounts(db: RouteDeps["db"]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const key of Object.keys(config.tables)) {
		if (key === "tenants") continue;
		const table = config.tables[key];
		if (!table) continue;
		const rows = db.prepare(`/* system */ SELECT tenant_id AS tenantId, COUNT(*) AS n FROM ${table} GROUP BY tenant_id`).all() as Array<{ tenantId: string; n: number }>;
		for (const row of rows) counts[String(row.tenantId)] = (counts[String(row.tenantId)] ?? 0) + Number(row.n ?? 0);
	}
	return counts;
}

/** 该租户在每张业务表里的行数(导出与清除时用,顺带作为删除范围的确认)。 */
function tenantTableBreakdown(db: RouteDeps["db"], tenantId: string): Array<{ table: string; rows: number }> {
	const out: Array<{ table: string; rows: number }> = [];
	for (const key of Object.keys(config.tables)) {
		if (key === "tenants") continue;
		const table = config.tables[key];
		if (!table) continue;
		const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ?`).get(tenantId) as { n: number } | undefined;
		out.push({ table, rows: Number(row?.n ?? 0) });
	}
	return out;
}

export function registerTenantRoutes(app: FastifyInstance, deps: RouteDeps): void {
	app.get("/api/v1/tenants", async (request, reply) => {
		if (!requireAdmin(request, reply)) return;
		const counts = tenantRowCounts(deps.db);
		return {
			tenants: listTenantRows(deps.db).map((row) => ({ ...row, dataRows: counts[row.id] ?? 0, isDefault: row.id === config.tenantId })),
			defaultTenantId: config.tenantId,
		};
	});

	app.post<{ Body: { id?: string; name?: string; slug?: string } }>("/api/v1/tenants", async (request, reply) => {
		if (!requireAdmin(request, reply)) return;
		const id = String(request.body?.id ?? "").trim();
		const name = String(request.body?.name ?? "").trim();
		const slug = String(request.body?.slug ?? "").trim() || (id ? `t-${id.slice(0, 8)}` : "");
		if (!/^[A-Za-z0-9_.-]{2,64}$/.test(id)) return reply.code(400).send({ error: "invalid_request", message: "id 必填,2-64 位,只允许字母数字与 _ . -。" });
		if (!name) return reply.code(400).send({ error: "invalid_request", message: "name 必填。" });
		const exists = deps.db.prepare(`/* system */ SELECT id FROM ${tenantTable()} WHERE id = ?`).get(id);
		if (exists) return reply.code(409).send({ error: "tenant_exists", message: `租户已存在:${id}` });
		deps.db.prepare(`/* system */ INSERT INTO ${tenantTable()} (id, name, slug) VALUES (?,?,?)`).run(id, name, slug);
		return { id, name, slug };
	});

	app.patch<{ Params: { id: string }; Body: { name?: string } }>("/api/v1/tenants/:id", async (request, reply) => {
		if (!requireAdmin(request, reply)) return;
		const name = String(request.body?.name ?? "").trim();
		if (!name) return reply.code(400).send({ error: "invalid_request", message: "name 必填。" });
		const changed = deps.db.prepare(`/* system */ UPDATE ${tenantTable()} SET name = ? WHERE id = ?`).run(name, request.params.id).changes;
		if (changed === 0) return reply.code(404).send({ error: "not_found", message: "租户不存在。" });
		return { ok: true };
	});

	/** 按租户导出:每张业务表一行 JSON,便于迁到专属库(配合 docs 里的迁移说明)。 */
	app.get<{ Params: { id: string }; Querystring: { limit?: string } }>("/api/v1/tenants/:id/export", async (request, reply) => {
		if (!requireAdmin(request, reply)) return;
		const tenantId = request.params.id;
		const limit = Math.min(Math.max(Number(request.query?.limit ?? 1000) || 1000, 1), 20000);
		const exists = deps.db.prepare(`/* system */ SELECT id FROM ${tenantTable()} WHERE id = ?`).get(tenantId);
		if (!exists) return reply.code(404).send({ error: "not_found", message: "租户不存在。" });
		const tables: Record<string, Array<Record<string, unknown>>> = {};
		for (const key of Object.keys(config.tables)) {
			if (key === "tenants") continue;
			const table = config.tables[key];
			if (!table) continue;
			tables[table] = deps.db.prepare(`SELECT * FROM ${table} WHERE tenant_id = ? LIMIT ?`).all(tenantId, limit) as Array<Record<string, unknown>>;
		}
		return { tenantId, exportedAt: new Date().toISOString(), limit, tables };
	});

	/** 清除租户:先清向量,再按 tenant_id 删业务表数据,最后删租户行。 */
	app.delete<{ Params: { id: string }; Querystring: { confirm?: string } }>("/api/v1/tenants/:id", async (request, reply) => {
		if (!requireAdmin(request, reply)) return;
		const tenantId = request.params.id;
		if (tenantId === config.tenantId) return reply.code(400).send({ error: "invalid_request", message: "默认租户不允许清除(避免把演示环境删空)。" });
		if (request.query?.confirm !== tenantId) return reply.code(400).send({ error: "confirm_required", message: `清除不可恢复:请在 query 里带上 confirm=${tenantId}。`, breakdown: tenantTableBreakdown(deps.db, tenantId) });
		const exists = deps.db.prepare(`/* system */ SELECT id FROM ${tenantTable()} WHERE id = ?`).get(tenantId);
		if (!exists) return reply.code(404).send({ error: "not_found", message: "租户不存在。" });

		const breakdown = tenantTableBreakdown(deps.db, tenantId);
		// 向量库按 chunk 删除(Milvus 侧不在事务里,先删数据行再删向量最容易漏,所以反过来)
		const chunkRows = deps.db.prepare("SELECT chunk_id AS id FROM knowledge_embeddings WHERE tenant_id = ?").all(tenantId) as Array<{ id: string }>;
		if (chunkRows.length > 0) await removeChunkVectors(deps.db, tenantId, chunkRows.map((r) => r.id)).catch(() => undefined);

		for (const key of Object.keys(config.tables)) {
			if (key === "tenants") continue;
			const table = config.tables[key];
			if (!table) continue;
			deps.db.prepare(`DELETE FROM ${table} WHERE tenant_id = ?`).run(tenantId);
		}
		deps.db.prepare(`/* system */ DELETE FROM ${tenantTable()} WHERE id = ?`).run(tenantId);
		return { ok: true, tenantId, removed: breakdown.filter((b) => b.rows > 0) };
	});
}