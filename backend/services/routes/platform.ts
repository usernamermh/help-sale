/**
 * 平台层接口(总部):开门店租户、停用/改名/清数据、重置门店管理员、看跨门店汇总。
 *
 * 与门店层接口的分工写在 README「门店即租户」一节:平台令牌不带租户,只能走 /api/v1/platform/*;
 * 门店令牌只能在自己租户里活动,碰不到别的门店。
 */
import type { FastifyInstance } from "fastify";
import { config } from "../../env.js";
import { signToken } from "../auth.js";
import type { RouteDeps } from "./helpers.js";
import { requireTenant } from "../../integrations_pi/tables/crm/customers.js";
import { createUser, countAdmins, getUserByUsername, updateUser } from "../../integrations_pi/tables/agents/users.js";
import { createPlatformAdmin, countPlatformAdmins, deletePlatformAdmin, getPlatformAdminByUsername, listPlatformAdmins, updatePlatformAdmin, verifyPassword as verifyPlatformPassword, type PlatformAdmin } from "../../integrations_pi/tables/agents/platform-admins.js";
import { upsertStore, listStores } from "../../integrations_pi/tables/sales/stores.js";

/** 平台层接口只认平台令牌。 */
function requirePlatform(request: { platformAdmin?: boolean }, reply: { code: (n: number) => { send: (body: unknown) => unknown } }): boolean {
	if (request.platformAdmin) return true;
	reply.code(403).send({ error: "forbidden", message: "该接口属于总部平台层,需要平台管理员登录(POST /api/v1/platform/login)。" });
	return false;
}

function tenantTable(): string {
	return config.tables.tenants ?? "tenants";
}

interface TenantSummary {
	id: string;
	name: string;
	slug: string;
	createdAt: string;
	dataRows: number;
	stores: number;
	users: number;
}

/** 每店数据量:一次 group by 拿全量,避免按店逐个 COUNT。 */
function dataRowsByTenant(db: RouteDeps["db"]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const key of Object.keys(config.tables)) {
		if (["tenants", "platform_admins"].includes(key)) continue;
		const table = config.tables[key];
		if (!table) continue;
		const rows = db.prepare(`/* system */ SELECT tenant_id AS tenantId, COUNT(*) AS n FROM ${table} GROUP BY tenant_id`).all() as Array<{ tenantId: string; n: number }>;
		for (const row of rows) out[String(row.tenantId)] = (out[String(row.tenantId)] ?? 0) + Number(row.n ?? 0);
	}
	return out;
}

function summarize(db: RouteDeps["db"]): TenantSummary[] {
	const rows = db.prepare(`/* system */ SELECT id, name, slug, created_at FROM ${tenantTable()} ORDER BY created_at, id`).all() as Array<Record<string, unknown>>;
	const counts = dataRowsByTenant(db);
	return rows.map((row) => {
		const id = String(row.id);
		const storeRows = db.prepare(`/* system */ SELECT COUNT(*) AS n FROM stores WHERE tenant_id = ?`).get(id) as { n: number };
		const userRows = db.prepare(`/* system */ SELECT COUNT(*) AS n FROM users WHERE tenant_id = ?`).get(id) as { n: number };
		return {
			id,
			name: String(row.name ?? ""),
			slug: String(row.slug ?? ""),
			createdAt: row.created_at ? String(row.created_at) : "",
			dataRows: counts[id] ?? 0,
			stores: Number(storeRows?.n ?? 0),
			users: Number(userRows?.n ?? 0),
		};
	});
}

export function registerPlatformRoutes(app: FastifyInstance, deps: RouteDeps): void {
	// ── 平台登录(不需要租户,也不需要令牌) ──
	app.post<{ Body: { username?: string; password?: string } }>("/api/v1/platform/login", async (request, reply) => {
		const username = String(request.body?.username ?? "").trim();
		const password = String(request.body?.password ?? "");
		if (!username || !password) return reply.code(400).send({ error: "invalid_request", message: "username 与 password 都是必填的。" });
		const admin = getPlatformAdminByUsername(deps.db, username);
		if (!admin || !admin.enabled || !verifyPlatformPassword(password, admin.passwordHash)) {
			return reply.code(401).send({ error: "auth_failed", message: "用户名或密码不正确。" });
		}
		const token = signToken(
			{ scope: "platform", tenantId: "", userId: admin.id, username: admin.username, role: "admin" },
			{ tokenTtlHours: config.authTokenTtlHours, tokenSecret: config.authTokenSecret },
		);
		return { token, scope: "platform", expiresInHours: config.authTokenTtlHours, admin: { id: admin.id, username: admin.username } };
	});

	app.get("/api/v1/platform/me", async (request, reply) => {
		if (!requirePlatform(request, reply)) return;
		return { scope: "platform", platformAdminId: request.platformAdminId ?? null };
	});

	// ── 门店租户生命周期 ──
	app.get("/api/v1/platform/tenants", async (request, reply) => {
		if (!requirePlatform(request, reply)) return;
		return { tenants: summarize(deps.db), defaultTenantId: config.tenantId };
	});

	app.post<{ Body: { id?: string; name?: string; address?: string; adminUsername?: string; adminPassword?: string } }>("/api/v1/platform/tenants", async (request, reply) => {
		if (!requirePlatform(request, reply)) return;
		const id = String(request.body?.id ?? "").trim();
		const name = String(request.body?.name ?? "").trim();
		const adminUsername = String(request.body?.adminUsername ?? "").trim() || "admin";
		const adminPassword = String(request.body?.adminPassword ?? "");
		if (!/^[A-Za-z0-9_.-]{2,64}$/.test(id)) return reply.code(400).send({ error: "invalid_request", message: "id 必填,2-64 位,只允许字母数字与 _ . -。" });
		if (!name) return reply.code(400).send({ error: "invalid_request", message: "name 必填(门店名)。" });
		if (adminPassword.length < 8) return reply.code(400).send({ error: "invalid_request", message: "adminPassword 至少 8 位(门店管理员初始密码)。" });
		const exists = deps.db.prepare(`/* system */ SELECT id FROM ${tenantTable()} WHERE id = ?`).get(id);
		if (exists) return reply.code(409).send({ error: "tenant_exists", message: `门店已存在:${id}` });

		deps.db.prepare(`/* system */ INSERT INTO ${tenantTable()} (id, name, slug) VALUES (?,?,?)`).run(id, name, `t-${id.slice(0, 8)}`);
		// 门店租户自带一条 stores 记录(门店名/地址),报告与销售归属都用它
		const store = upsertStore(deps.db, id, { name, address: String(request.body?.address ?? "").trim() || undefined });
		const admin = createUser(deps.db, { tenantId: id, username: adminUsername, password: adminPassword, role: "admin" });
		return { id, name, storeId: store.id, admin: { id: admin.id, username: admin.username } };
	});

	app.patch<{ Params: { id: string }; Body: { name?: string; address?: string } }>("/api/v1/platform/tenants/:id", async (request, reply) => {
		if (!requirePlatform(request, reply)) return;
		const id = request.params.id;
		const exists = deps.db.prepare(`/* system */ SELECT id FROM ${tenantTable()} WHERE id = ?`).get(id);
		if (!exists) return reply.code(404).send({ error: "not_found", message: "门店不存在。" });
		const name = String(request.body?.name ?? "").trim();
		if (name) {
			deps.db.prepare(`/* system */ UPDATE ${tenantTable()} SET name = ? WHERE id = ?`).run(name, id);
			const store = listStores(deps.db, id)[0];
			if (store) upsertStore(deps.db, id, { name, address: String(request.body?.address ?? store.address ?? "").trim() || undefined });
		}
		return { ok: true };
	});

	/** 重置门店管理员密码 / 停用账号(总部兜底,门店自己改不了密码时用)。 */
	app.post<{ Params: { id: string }; Body: { username?: string; password?: string; enabled?: boolean } }>("/api/v1/platform/tenants/:id/admin", async (request, reply) => {
		if (!requirePlatform(request, reply)) return;
		const tenantId = request.params.id;
		const username = String(request.body?.username ?? "").trim() || "admin";
		const user = getUserByUsername(deps.db, tenantId, username);
		if (!user) return reply.code(404).send({ error: "not_found", message: `门店 ${tenantId} 下没有账号 ${username}。` });
		const password = request.body?.password === undefined ? undefined : String(request.body.password);
		if (password !== undefined && password.length < 8) return reply.code(400).send({ error: "invalid_request", message: "password 至少 8 位。" });
		updateUser(deps.db, tenantId, user.id, { password, enabled: request.body?.enabled });
		return { ok: true, tenantId, username };
	});

	/** 跨门店只读汇总:数据量、门店数、账号数(不落明细,避免总部越界看门店业务数据)。 */
	app.get("/api/v1/platform/overview", async (request, reply) => {
		if (!requirePlatform(request, reply)) return;
		const tenants = summarize(deps.db);
		return {
			stores: tenants.length,
			dataRows: tenants.reduce((sum, t) => sum + t.dataRows, 0),
			accounts: tenants.reduce((sum, t) => sum + t.users, 0),
			tenants,
		};
	});

	// ── 平台管理员自身账号 ──
	app.get("/api/v1/platform/admins", async (request, reply) => {
		if (!requirePlatform(request, reply)) return;
		return { admins: listPlatformAdmins(deps.db).map((a: PlatformAdmin) => ({ id: a.id, username: a.username, enabled: a.enabled, createdAt: a.createdAt })) };
	});

	app.post<{ Body: { username?: string; password?: string } }>("/api/v1/platform/admins", async (request, reply) => {
		if (!requirePlatform(request, reply)) return;
		const username = String(request.body?.username ?? "").trim();
		const password = String(request.body?.password ?? "");
		if (username.length < 2) return reply.code(400).send({ error: "invalid_request", message: "username 至少 2 个字符。" });
		if (password.length < 8) return reply.code(400).send({ error: "invalid_request", message: "password 至少 8 位。" });
		if (getPlatformAdminByUsername(deps.db, username)) return reply.code(409).send({ error: "admin_exists", message: `平台账号已存在:${username}` });
		const created = createPlatformAdmin(deps.db, { username, password });
		return { id: created.id, username: created.username };
	});

	app.delete<{ Params: { id: string } }>("/api/v1/platform/admins/:id", async (request, reply) => {
		if (!requirePlatform(request, reply)) return;
		if (request.params.id === request.platformAdminId) return reply.code(400).send({ error: "invalid_request", message: "不能删除自己当前登录的平台账号。" });
		if (!deletePlatformAdmin(deps.db, request.params.id)) return reply.code(404).send({ error: "not_found", message: "平台账号不存在。" });
		if (countPlatformAdmins(deps.db) === 0) {
			return reply.code(400).send({ error: "invalid_request", message: "至少保留一个可用的平台管理员。" });
		}
		return { ok: true };
	});

	// ── 门店数据清除(不可恢复,要显式确认) ──
	app.delete<{ Params: { id: string }; Querystring: { confirm?: string } }>("/api/v1/platform/tenants/:id", async (request, reply) => {
		if (!requirePlatform(request, reply)) return;
		const tenantId = request.params.id;
		if (tenantId === config.tenantId) return reply.code(400).send({ error: "invalid_request", message: "默认门店不允许清除。" });
		if (request.query?.confirm !== tenantId) return reply.code(400).send({ error: "confirm_required", message: `清除不可恢复:请在 query 里带上 confirm=${tenantId}。` });
		const exists = deps.db.prepare(`/* system */ SELECT id FROM ${tenantTable()} WHERE id = ?`).get(tenantId);
		if (!exists) return reply.code(404).send({ error: "not_found", message: "门店不存在。" });
		const removed: Array<{ table: string; rows: number }> = [];
		const chunkRows = deps.db.prepare("SELECT chunk_id AS id FROM knowledge_embeddings WHERE tenant_id = ?").all(tenantId) as Array<{ id: string }>;
		if (chunkRows.length > 0) {
			const { removeChunkVectors } = await import("../vector-store.js");
			await removeChunkVectors(deps.db, tenantId, chunkRows.map((r) => r.id)).catch(() => undefined);
		}
		for (const key of Object.keys(config.tables)) {
			if (["tenants", "platform_admins"].includes(key)) continue;
			const table = config.tables[key];
			if (!table) continue;
			const before = deps.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ?`).get(tenantId) as { n: number };
			deps.db.prepare(`DELETE FROM ${table} WHERE tenant_id = ?`).run(tenantId);
			if (Number(before?.n ?? 0) > 0) removed.push({ table, rows: Number(before.n) });
		}
		deps.db.prepare(`/* system */ DELETE FROM ${tenantTable()} WHERE id = ?`).run(tenantId);
		return { ok: true, tenantId, removed };
	});
}