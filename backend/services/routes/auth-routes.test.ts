import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app.js";
import { openSessionStore, tmpDataDir, cleanupDataDir, type SessionStore } from "../../integrations_pi/sessions.js";
import { createMemoryReminderQueue } from "../../integrations_db/reminder-queue.js";
import { config } from "../../env.js";

/**
 * 登录 + RBAC 的端到端行为(auth.enabled=true 时):
 *   - 不带凭证:业务接口 401;
 *   - 登录换令牌:业务接口放行;
 *   - 管理员接口:member 403,admin 放行;
 *   - 伪造/过期令牌 401。
 */

let app: FastifyInstance;
let store: SessionStore;
let dir: string;
let adminToken = "";

beforeEach(async () => {
	dir = tmpDataDir("auth-routes");
	store = openSessionStore(dir);
	app = buildApp({ dataDir: dir, reminders: createMemoryReminderQueue() });
	const res = await app.inject({
		method: "POST",
		url: "/api/v1/auth/login",
		payload: { username: config.authBootstrapUsername, password: config.authBootstrapPassword },
		headers: { "x-tenant-id": config.authBootstrapTenantId },
	});
	adminToken = res.json().token ?? "";
});

afterEach(async () => {
	await app.close();
	await store.close();
	cleanupDataDir(dir);
});

describe("登录与 RBAC", () => {
	it("不带凭证访问业务接口 → 401", async () => {
		const res = await app.inject({ method: "GET", url: "/api/v1/agent/threads", headers: { "x-tenant-id": config.authBootstrapTenantId } });
		expect(res.statusCode).toBe(401);
		expect(res.json().error).toBe("unauthenticated");
	});

	it("初始管理员可登录并拿到令牌", () => {
		expect(adminToken.startsWith("hsu1.")).toBe(true);
	});

	it("带令牌可以访问业务接口", async () => {
		const res = await app.inject({ method: "GET", url: "/api/v1/agent/threads", headers: { authorization: `Bearer ${adminToken}` } });
		expect(res.statusCode).toBe(200);
	});

	it("密码错误 → 401,且不泄露账号是否存在", async () => {
		const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: config.authBootstrapUsername, password: "wrong-password" }, headers: { "x-tenant-id": config.authBootstrapTenantId } });
		expect(res.statusCode).toBe(401);
		expect(res.json().error).toBe("auth_failed");
	});

	it("管理员能建账号;member 访问管理员接口 → 403", async () => {
		const created = await app.inject({
			method: "POST",
			url: "/api/v1/auth/users",
			payload: { username: "member01", password: "member01_pwd" },
			headers: { authorization: `Bearer ${adminToken}` },
		});
		expect(created.statusCode).toBe(200);
		expect(created.json().role).toBe("member");

		const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "member01", password: "member01_pwd" }, headers: { "x-tenant-id": config.authBootstrapTenantId } });
		const memberToken = login.json().token as string;

		const forbidden = await app.inject({ method: "GET", url: "/api/v1/auth/users", headers: { authorization: `Bearer ${memberToken}` } });
		expect(forbidden.statusCode).toBe(403);
		expect(forbidden.json().error).toBe("forbidden");

		const allowed = await app.inject({ method: "GET", url: "/api/v1/auth/users", headers: { authorization: `Bearer ${adminToken}` } });
		expect(allowed.statusCode).toBe(200);
		expect(allowed.json().users.map((u: { username: string }) => u.username)).toContain("member01");
	});

	it("伪造令牌 → 401", async () => {
		const res = await app.inject({ method: "GET", url: "/api/v1/agent/threads", headers: { authorization: "Bearer hsu1.eyJ0ZW5hbnRJZCI6InQifQ.AAAA" } });
		expect(res.statusCode).toBe(401);
	});
});