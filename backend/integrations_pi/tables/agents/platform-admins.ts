/**
 * 平台管理员(总部)账号:全局表,**不属于任何门店租户**。
 *
 * 与门店账号(users,带 tenant_id)的分工:
 *   - 平台管理员:开门店租户、停用/改名/清数据、重置门店管理员密码、看跨门店汇总;
 *   - 门店管理员(users.role=admin):只管自己这摊 —— 本店账号、本店凭证、本店知识库与数据。
 */
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface PlatformAdmin {
	id: string;
	username: string;
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
}

const SCRYPT_KEYLEN = 32;

export function hashPassword(password: string): string {
	const salt = randomBytes(16);
	const derived = scryptSync(String(password), salt, SCRYPT_KEYLEN);
	return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
	const parts = String(stored ?? "").split("$");
	if (parts.length !== 3 || parts[0] !== "scrypt") return false;
	const salt = Buffer.from(parts[1], "hex");
	const expected = Buffer.from(parts[2], "hex");
	if (salt.length === 0 || expected.length !== SCRYPT_KEYLEN) return false;
	return timingSafeEqual(scryptSync(String(password), salt, SCRYPT_KEYLEN), expected);
}

function toRecord(row: Record<string, unknown>): PlatformAdmin {
	return {
		id: String(row.id),
		username: String(row.username),
		enabled: Number(row.enabled ?? 0) !== 0,
		createdAt: row.created_at ? String(row.created_at) : "",
		updatedAt: row.updated_at ? String(row.updated_at) : "",
	};
}

export function listPlatformAdmins(db: DatabaseSync): PlatformAdmin[] {
	const rows = db.prepare("/* system */ SELECT id, username, enabled, created_at, updated_at FROM platform_admins ORDER BY username").all() as Array<Record<string, unknown>>;
	return rows.map(toRecord);
}

export function getPlatformAdminById(db: DatabaseSync, id: string): PlatformAdmin | undefined {
	const row = db.prepare("/* system */ SELECT id, username, enabled, created_at, updated_at FROM platform_admins WHERE id = ?").get(id) as Record<string, unknown> | undefined;
	return row ? toRecord(row) : undefined;
}

export function getPlatformAdminByUsername(db: DatabaseSync, username: string): (PlatformAdmin & { passwordHash: string }) | undefined {
	const row = db.prepare("/* system */ SELECT * FROM platform_admins WHERE username = ?").get(username) as Record<string, unknown> | undefined;
	if (!row) return undefined;
	return { ...toRecord(row), passwordHash: String(row.password_hash ?? "") };
}

export function countPlatformAdmins(db: DatabaseSync): number {
	const row = db.prepare("/* system */ SELECT COUNT(*) AS n FROM platform_admins WHERE enabled = 1").get() as { n: number };
	return Number(row?.n ?? 0);
}

export function createPlatformAdmin(db: DatabaseSync, input: { username: string; password: string }): PlatformAdmin {
	const id = randomUUID();
	db.prepare(
		`/* system */ INSERT INTO platform_admins (id, username, password_hash, enabled, created_at, updated_at)
		 VALUES (?,?,?,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
	).run(id, input.username, hashPassword(input.password));
	return getPlatformAdminById(db, id)!;
}

export function updatePlatformAdmin(db: DatabaseSync, id: string, patch: { password?: string; enabled?: boolean }): boolean {
	const current = getPlatformAdminById(db, id);
	if (!current) return false;
	const hash = patch.password
		? hashPassword(patch.password)
		: (db.prepare("/* system */ SELECT password_hash AS h FROM platform_admins WHERE id = ?").get(id) as { h: string }).h;
	db.prepare("/* system */ UPDATE platform_admins SET password_hash = ?, enabled = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(
		hash,
		(patch.enabled ?? current.enabled) ? 1 : 0,
		id,
	);
	return true;
}

export function deletePlatformAdmin(db: DatabaseSync, id: string): boolean {
	return db.prepare("/* system */ DELETE FROM platform_admins WHERE id = ?").run(id).changes > 0;
}