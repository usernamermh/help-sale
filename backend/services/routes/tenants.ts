/**
 * 门店自助接口(门店管理员用):只看得到、也只改得动自己这家店。
 *
 * 跨门店的操作(开门店、停用、清数据、重置门店管理员、跨店汇总)在 platform.ts,走平台令牌。
 */
import type { FastifyInstance } from "fastify";
import { config } from "../../env.js";
import { requireAdmin, type RouteDeps } from "./helpers.js";
import { deleteTenantSecret, listTenantSecrets, TENANT_SECRET_NAMES, writeTenantSecret } from "../../integrations_pi/tables/agents/tenant-secrets.js";
import { listTenantConfig, readTenantConfig, TENANT_CONFIG_NAMES } from "../../integrations_pi/tables/agents/tenant-config.js";
import { tenantMcpServers, tenantModelConfig, tenantWebSearchKey } from "../tenant-credentials.js";
import { listStores } from "../../integrations_pi/tables/sales/stores.js";

function mask(value: string): string {
	const v = String(value ?? "");
	if (!v) return "";
	if (v.length <= 8) return "*".repeat(v.length);
	return `${v.slice(0, 4)}…${v.slice(-2)}(共 ${v.length} 位)`;
}

function tenantTable(): string {
	return config.tables.tenants ?? "tenants";
}

/** 只能操作自己:路径里的门店 id 必须等于当前登录的租户。 */
function selfOnly(tenantId: string, requestTenantId: string): boolean {
	return Boolean(tenantId) && tenantId === requestTenantId;
}

export function registerTenantRoutes(app: FastifyInstance, deps: RouteDeps): void {
	/** 本店信息(报表口径与门店名)。 */
	app.get("/api/v1/tenants", async (request, reply) => {
		if (!requireAdmin(request, reply)) return;
		const row = deps.db.prepare(`/* system */ SELECT id, name, slug, created_at FROM ${tenantTable()} WHERE id = ?`).get(request.tenantId) as Record<string, unknown> | undefined;
		if (!row) return reply.code(404).send({ error: "not_found", message: "当前租户不存在。" });
		return {
			tenant: {
				id: String(row.id),
				name: String(row.name ?? ""),
				slug: String(row.slug ?? ""),
				createdAt: row.created_at ? String(row.created_at) : "",
				stores: listStores(deps.db, request.tenantId).map((s) => ({ id: s.id, name: s.name, address: s.address ?? null })),
			},
			// 跨门店视角在平台层:/api/v1/platform/tenants
		};
	});

	/** 本店凭证:看有哪些覆盖项与脱敏生效值。 */
	app.get<{ Params: { id: string } }>("/api/v1/tenants/:id/secrets", async (request, reply) => {
		if (!requireAdmin(request, reply)) return;
		if (!selfOnly(request.params.id, request.tenantId)) return reply.code(403).send({ error: "forbidden", message: "只能管理本店凭证。" });
		const tenantId = request.tenantId;
		const rows = [...listTenantSecrets(deps.db, tenantId), ...listTenantConfig(deps.db, tenantId)];
		const overridden = new Set(rows.map((row) => row.name));
		return {
			tenantId,
			supported: TENANT_SECRET_NAMES,
			overridden: [...overridden],
			updatedAt: Object.fromEntries(rows.map((row) => [row.name, row.updatedAt])),
			effective: {
				"model.modelId": { value: tenantModelConfig(deps.db, tenantId).modelId, fromTenant: overridden.has("model.modelId") },
				"model.baseUrl": { value: tenantModelConfig(deps.db, tenantId).baseUrl, fromTenant: overridden.has("model.baseUrl") },
				"model.apiKey": { masked: mask(tenantModelConfig(deps.db, tenantId).apiKey), fromTenant: overridden.has("model.apiKey") },
				"tools.webSearch.apiKey": { masked: mask(tenantWebSearchKey(deps.db, tenantId)), fromTenant: overridden.has("tools.webSearch.apiKey") },
				"mcp.servers": { count: tenantMcpServers(deps.db, tenantId).length, fromTenant: overridden.has("mcp.servers") },
			},
		};
	});

	app.put<{ Params: { id: string; name: string }; Body: { value?: string } }>("/api/v1/tenants/:id/secrets/:name", async (request, reply) => {
		if (!requireAdmin(request, reply)) return;
		if (!selfOnly(request.params.id, request.tenantId)) return reply.code(403).send({ error: "forbidden", message: "只能管理本店凭证。" });
		const name = String(request.params.name ?? "");
		if (!TENANT_SECRET_NAMES.includes(name as (typeof TENANT_SECRET_NAMES)[number])) {
			return reply.code(400).send({ error: "invalid_request", message: `不支持的凭证名:${name}`, supported: TENANT_SECRET_NAMES });
		}
		if (typeof request.body?.value !== "string" || request.body.value.trim() === "") {
			return reply.code(400).send({ error: "invalid_request", message: "value 必填(要清除请用 DELETE)。" });
		}
		writeTenantSecret(deps.db, request.tenantId, name, request.body.value);
		return { ok: true, tenantId: request.tenantId, name };
	});

	app.delete<{ Params: { id: string; name: string } }>("/api/v1/tenants/:id/secrets/:name", async (request, reply) => {
		if (!requireAdmin(request, reply)) return;
		if (!selfOnly(request.params.id, request.tenantId)) return reply.code(403).send({ error: "forbidden", message: "只能管理本店凭证。" });
		const removed = deleteTenantSecret(deps.db, request.tenantId, String(request.params.name ?? ""));
		if (!removed) return reply.code(404).send({ error: "not_found", message: "本店没有覆盖这一项。" });
		return { ok: true };
	});

	/** 本店导出(迁到独立库/备份用)。 */
	app.get<{ Params: { id: string }; Querystring: { limit?: string } }>("/api/v1/tenants/:id/export", async (request, reply) => {
		if (!requireAdmin(request, reply)) return;
		if (!selfOnly(request.params.id, request.tenantId)) return reply.code(403).send({ error: "forbidden", message: "只能导出本店数据。" });
		const tenantId = request.tenantId;
		const limit = Math.min(Math.max(Number(request.query?.limit ?? 1000) || 1000, 1), 20000);
		const tables: Record<string, Array<Record<string, unknown>>> = {};
		for (const key of Object.keys(config.tables)) {
			if (["tenants", "platform_admins"].includes(key)) continue;
			const table = config.tables[key];
			if (!table) continue;
			tables[table] = deps.db.prepare(`SELECT * FROM ${table} WHERE tenant_id = ? LIMIT ?`).all(tenantId, limit) as Array<Record<string, unknown>>;
		}
		return { tenantId, exportedAt: new Date().toISOString(), limit, tables };
	});
}