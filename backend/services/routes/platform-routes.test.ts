import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.js";
import { openSessionStore, tmpDataDir, cleanupDataDir, type SessionStore } from "../../integrations_pi/sessions.js";
import { createMemoryReminderQueue } from "../../integrations_db/reminder-queue.js";
import { config } from "../../env.js";

/**
 * 门店即租户:平台层(总部)与门店层的边界。
 *   平台令牌只能走 /api/v1/platform/*,门店令牌只能在自己租户里活动。
 */

let app: FastifyInstance;
let store: SessionStore;
let dir: string;
let platformToken = "";

async function login(path: string, payload: Record<string, unknown>, tenantId?: string): Promise<string> {
	const res = await app.inject({ method: "POST", url: path, payload, headers: tenantId ? { "x-tenant-id": tenantId } : {} });
	return String(res.json().token ?? "");
}

beforeEach(async () => {
	dir = tmpDataDir("platform-routes");
	store = openSessionStore(dir);
	app = buildApp({ dataDir: dir, reminders: createMemoryReminderQueue() });
	platformToken = await login("/api/v1/platform/login", { username: config.authPlatformUsername, password: config.authPlatformPassword });
});

afterEach(async () => {
	await app.close();
	await store.close();
	cleanupDataDir(dir);
});

describe("平台层与门店层", () => {
	it("平台登录后能管门店;平台令牌碰门店接口 403", async () => {
		const list = await app.inject({ method: "GET", url: "/api/v1/platform/tenants", headers: { authorization: `Bearer ${platformToken}` } });
		expect(list.statusCode).toBe(200);
		expect(list.json().tenants.map((t: { id: string }) => t.id)).toContain(config.tenantId);

		const forbidden = await app.inject({ method: "GET", url: "/api/v1/agent/threads", headers: { authorization: `Bearer ${platformToken}` } });
		expect(forbidden.statusCode).toBe(403);
	});

	it("开门店 = 建租户 + 建门店记录 + 建门店管理员,一次成店", async () => {
		const created = await app.inject({
			method: "POST",
			url: "/api/v1/platform/tenants",
			payload: { id: "store_t1", name: "测试门店", address: "某某路 1 号", adminUsername: "mgr", adminPassword: "mgr_pwd_2026" },
			headers: { authorization: `Bearer ${platformToken}` },
		});
		expect(created.statusCode).toBe(200);
		expect(created.json().storeId).toBeTruthy();

		const tokens = await login("/api/v1/auth/login", { username: "mgr", password: "mgr_pwd_2026" }, "store_t1");
		expect(tokens.startsWith("hsu1.")).toBe(true);

		const self = await app.inject({ method: "GET", url: "/api/v1/tenants", headers: { authorization: `Bearer ${tokens}` } });
		expect(self.statusCode).toBe(200);
		expect(self.json().tenant.id).toBe("store_t1");
		expect(self.json().tenant.stores[0].name).toBe("测试门店");
	});

	it("门店管理员碰不到平台层,也碰不到别店", async () => {
		await app.inject({
			method: "POST",
			url: "/api/v1/platform/tenants",
			payload: { id: "store_t2", name: "测试门店2", adminPassword: "mgr_pwd_2026" },
			headers: { authorization: `Bearer ${platformToken}` },
		});
		const storeToken = await login("/api/v1/auth/login", { username: "admin", password: "mgr_pwd_2026" }, "store_t2");

		const platform = await app.inject({ method: "GET", url: "/api/v1/platform/tenants", headers: { authorization: `Bearer ${storeToken}` } });
		expect(platform.statusCode).toBe(403);
		const otherStore = await app.inject({ method: "GET", url: `/api/v1/tenants/${config.tenantId}/secrets`, headers: { authorization: `Bearer ${storeToken}` } });
		expect(otherStore.statusCode).toBe(403);
		const ownSecrets = await app.inject({ method: "GET", url: "/api/v1/tenants/store_t2/secrets", headers: { authorization: `Bearer ${storeToken}` } });
		expect(ownSecrets.statusCode).toBe(200);
	});

	it("门店不存在时给出明确提示,不会悄悄建空门店", async () => {
		const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: "whatever" }, headers: { "x-tenant-id": "store_nope" } });
		expect(res.statusCode).toBe(404);
		expect(res.json().error).toBe("tenant_not_found");
	});

	it("平台重置门店管理员密码,旧密码立即失效", async () => {
		await app.inject({
			method: "POST",
			url: "/api/v1/platform/tenants",
			payload: { id: "store_t3", name: "测试门店3", adminPassword: "old_pwd_2026" },
			headers: { authorization: `Bearer ${platformToken}` },
		});
		const reset = await app.inject({
			method: "POST",
			url: "/api/v1/platform/tenants/store_t3/admin",
			payload: { username: "admin", password: "new_pwd_2026" },
			headers: { authorization: `Bearer ${platformToken}` },
		});
		expect(reset.statusCode).toBe(200);

		const oldLogin = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: "old_pwd_2026" }, headers: { "x-tenant-id": "store_t3" } });
		expect(oldLogin.statusCode).toBe(401);
		const newLogin = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: "new_pwd_2026" }, headers: { "x-tenant-id": "store_t3" } });
		expect(newLogin.statusCode).toBe(200);
	});

	it("清门店要显式确认,默认门店拒绝清除", async () => {
		await app.inject({
			method: "POST",
			url: "/api/v1/platform/tenants",
			payload: { id: "store_t4", name: "测试门店4", adminPassword: "mgr_pwd_2026" },
			headers: { authorization: `Bearer ${platformToken}` },
		});
		const noConfirm = await app.inject({ method: "DELETE", url: "/api/v1/platform/tenants/store_t4", headers: { authorization: `Bearer ${platformToken}` } });
		expect(noConfirm.statusCode).toBe(400);
		const confirmed = await app.inject({ method: "DELETE", url: "/api/v1/platform/tenants/store_t4?confirm=store_t4", headers: { authorization: `Bearer ${platformToken}` } });
		expect(confirmed.statusCode).toBe(200);
		const defaultTenant = await app.inject({ method: "DELETE", url: `/api/v1/platform/tenants/${config.tenantId}?confirm=${config.tenantId}`, headers: { authorization: `Bearer ${platformToken}` } });
		expect(defaultTenant.statusCode).toBe(400);
	});
});