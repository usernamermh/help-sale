/** 登录账号(users):租户内的用户名 → 角色,密码只存 scrypt 摘要。 */
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type UserRole = "admin" | "member";

export interface UserRecord {
	id: string;
	tenantId: string;
	username: string;
	role: UserRole;
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
}

const SCRYPT_KEYLEN = 32;

/** 生成密码摘要:scrypt$<salt 十六进制>$<摘要十六进制>,salt 每个账号独立。 */
export function hashPassword(password: string): string {
	const salt = randomBytes(16);
	const derived = scryptSync(String(password), salt, SCRYPT_KEYLEN);
	return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

/** 校验密码:用 timingSafeEqual 比摘要,格式不合法一律当失败。 */
export function verifyPassword(password: string, stored: string): boolean {
	const parts = String(stored ?? "").split("$");
	if (parts.length !== 3 || parts[0] !== "scrypt") return false;
	const salt = Buffer.from(parts[1], "hex");
	const expected = Buffer.from(parts[2], "hex");
	if (salt.length === 0 || expected.length !== SCRYPT_KEYLEN) return false;
	const derived = scryptSync(String(password), salt, SCRYPT_KEYLEN);
	return timingSafeEqual(derived, expected);
}

function toRecord(row: Record<string, unknown>): UserRecord {
	return {
		id: String(row.id),
		tenantId: String(row.tenant_id),
		username: String(row.username),
		role: String(row.role) === "admin" ? "admin" : "member",
		enabled: Number(row.enabled ?? 0) !== 0,
		createdAt: row.created_at ? String(row.created_at) : "",
		updatedAt: row.updated_at ? String(row.updated_at) : "",
	};
}

export function listUsers(db: DatabaseSync, tenantId: string): UserRecord[] {
	const rows = db.prepare("SELECT * FROM users WHERE tenant_id = ? ORDER BY username").all(tenantId) as Array<Record<string, unknown>>;
	return rows.map(toRecord);
}

export function getUserById(db: DatabaseSync, tenantId: string, id: string): UserRecord | undefined {
	const row = db.prepare("SELECT * FROM users WHERE tenant_id = ? AND id = ?").get(tenantId, id) as Record<string, unknown> | undefined;
	return row ? toRecord(row) : undefined;
}

export function getUserByUsername(db: DatabaseSync, tenantId: string, username: string): (UserRecord & { passwordHash: string }) | undefined {
	const row = db.prepare("SELECT * FROM users WHERE tenant_id = ? AND username = ?").get(tenantId, username) as Record<string, unknown> | undefined;
	if (!row) return undefined;
	return { ...toRecord(row), passwordHash: String(row.password_hash ?? "") };
}

export function createUser(db: DatabaseSync, input: { tenantId: string; username: string; password: string; role: UserRole }): UserRecord {
	const id = randomUUID();
	db.prepare(
		`INSERT INTO users (id, tenant_id, username, password_hash, role, enabled, created_at, updated_at)
		 VALUES (?,?,?,?,?,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
	).run(id, input.tenantId, input.username, hashPassword(input.password), input.role);
	return getUserById(db, input.tenantId, id)!;
}

export function updateUser(db: DatabaseSync, tenantId: string, id: string, patch: { password?: string; role?: UserRole; enabled?: boolean }): boolean {
	const current = getUserById(db, tenantId, id);
	if (!current) return false;
	db.prepare(
		`UPDATE users SET password_hash = ?, role = ?, enabled = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
		 WHERE tenant_id = ? AND id = ?`,
	).run(
		patch.password ? hashPassword(patch.password) : getUserByUsername(db, tenantId, current.username)!.passwordHash,
		patch.role ?? current.role,
		(patch.enabled ?? current.enabled) ? 1 : 0,
		tenantId,
		id,
	);
	return true;
}

export function deleteUser(db: DatabaseSync, tenantId: string, id: string): boolean {
	return db.prepare("DELETE FROM users WHERE tenant_id = ? AND id = ?").run(tenantId, id).changes > 0;
}

export function countAdmins(db: DatabaseSync, tenantId: string): number {
	const row = db.prepare("SELECT COUNT(*) AS n FROM users WHERE tenant_id = ? AND role = 'admin' AND enabled = 1").get(tenantId) as { n: number };
	return Number(row?.n ?? 0);
}