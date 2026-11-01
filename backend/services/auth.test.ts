import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { resolveIdentity, signToken, verifyToken } from "./auth.js";
import { createUser, hashPassword, updateUser, verifyPassword } from "../integrations_pi/tables/agents/users.js";

/** 登录与令牌:摘要、签名、过期、停用账号。 */

const SECRET = "test-secret-please-change";

function memoryDb(): DatabaseSync {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE tenants (id TEXT PRIMARY KEY, name TEXT, slug TEXT)");
	db.exec("INSERT INTO tenants (id, name, slug) VALUES ('t1','甲','t1')");
	db.exec(
		`CREATE TABLE users (
			id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, username TEXT NOT NULL,
			password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member',
			enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '',
			UNIQUE (tenant_id, username))`,
	);
	return db;
}

describe("密码摘要", () => {
	it("同一密码两次摘要不同(salt 随机),但都能校验通过", () => {
		const a = hashPassword("correct horse");
		const b = hashPassword("correct horse");
		expect(a).not.toBe(b);
		expect(verifyPassword("correct horse", a)).toBe(true);
		expect(verifyPassword("correct horse", b)).toBe(true);
	});

	it("错误密码与非法格式一律失败", () => {
		const stored = hashPassword("s3cret-password");
		expect(verifyPassword("s3cret-passwor", stored)).toBe(false);
		expect(verifyPassword("", stored)).toBe(false);
		expect(verifyPassword("s3cret-password", "md5$deadbeef")).toBe(false);
		expect(verifyPassword("s3cret-password", "")).toBe(false);
	});
});

describe("登录令牌", () => {
	it("签发后能验证,载荷带租户/账号/角色", () => {
		const token = signToken({ tenantId: "t1", userId: "u1", username: "admin", role: "admin" }, { tokenTtlHours: 1, tokenSecret: SECRET });
		const verified = verifyToken(token, { tokenSecret: SECRET });
		expect(verified.error).toBeUndefined();
		expect(verified.identity).toMatchObject({ tenantId: "t1", userId: "u1", role: "admin" });
	});

	it("过期令牌被拒", () => {
		const token = signToken({ tenantId: "t1", userId: "u1", username: "admin", role: "admin" }, { tokenTtlHours: 1, tokenSecret: SECRET }, Date.now() - 7200_000);
		expect(verifyToken(token, { tokenSecret: SECRET }).error).toMatch(/过期/);
	});

	it("换密钥或改内容就验不过", () => {
		const token = signToken({ tenantId: "t1", userId: "u1", username: "admin", role: "admin" }, { tokenTtlHours: 1, tokenSecret: SECRET });
		expect(verifyToken(token, { tokenSecret: "another-secret" }).error).toMatch(/签名/);
		const [prefix, payload] = token.split(".");
		const forged = `${prefix}.${payload}.AAAA`;
		expect(verifyToken(forged, { tokenSecret: SECRET }).error).toMatch(/签名/);
		expect(verifyToken("not-a-token", { tokenSecret: SECRET }).error).toMatch(/格式/);
	});
});

describe("请求身份解析", () => {
	it("令牌有效时以令牌里的租户为准(请求头不能覆盖)", () => {
		const db = memoryDb();
		const user = createUser(db, { tenantId: "t1", username: "admin", password: "admin_password", role: "admin" });
		const token = signToken({ tenantId: "t1", userId: user.id, username: "admin", role: "admin" }, { tokenTtlHours: 1, tokenSecret: SECRET });
		const resolved = resolveIdentity(db, { authorization: `Bearer ${token}`, "x-tenant-id": "t2" }, { enabled: true, tokenTtlHours: 1, tokenSecret: SECRET });
		expect(resolved.identity?.tenantId).toBe("t1");
		db.close();
	});

	it("账号被停用后令牌立即失效", () => {
		const db = memoryDb();
		const user = createUser(db, { tenantId: "t1", username: "admin", password: "admin_password", role: "admin" });
		const token = signToken({ tenantId: "t1", userId: user.id, username: "admin", role: "admin" }, { tokenTtlHours: 1, tokenSecret: SECRET });
		expect(resolveIdentity(db, { authorization: `Bearer ${token}` }, { enabled: true, tokenTtlHours: 1, tokenSecret: SECRET }).identity).toBeDefined();
		updateUser(db, "t1", user.id, { enabled: false });
		expect(resolveIdentity(db, { authorization: `Bearer ${token}` }, { enabled: true, tokenTtlHours: 1, tokenSecret: SECRET }).error).toMatch(/停用/);
		db.close();
	});

	it("没带令牌时不做判定(交给 API Key / 请求头那条路)", () => {
		const db = memoryDb();
		const resolved = resolveIdentity(db, {}, { enabled: true, tokenTtlHours: 1, tokenSecret: SECRET });
		expect(resolved.hasToken).toBe(false);
		expect(resolved.identity).toBeUndefined();
		expect(resolved.error).toBeUndefined();
		db.close();
	});
});