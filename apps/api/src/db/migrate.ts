import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

export const MIGRATION_VERSION = 9;

const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "schema.sql");

export function migrate(db: DatabaseSync): void {
	const current = db.prepare("PRAGMA user_version").get() as { user_version: number };
	if (current.user_version >= MIGRATION_VERSION) return;
	const sql = readFileSync(schemaPath, "utf8");
	db.exec(sql);
	// v8:重建 customer_tags(唯一约束改为 客户+标签,支持跨分析权重累加)
	if (current.user_version < 8) {
		db.exec("DROP TABLE IF EXISTS customer_tags;");
		db.exec(
			`CREATE TABLE IF NOT EXISTS customer_tags (
				id TEXT PRIMARY KEY,
				tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
				customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
				tag TEXT NOT NULL,
				kind TEXT NOT NULL DEFAULT 'auto',
				source TEXT,
				weight INTEGER NOT NULL DEFAULT 1,
				created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
				updated_at TEXT,
				UNIQUE (tenant_id, customer_id, tag)
			);`,
		);
	}
	db.exec(`PRAGMA user_version = ${MIGRATION_VERSION}`);
}