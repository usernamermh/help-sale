import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

export const MIGRATION_VERSION = 1;

const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "schema.sql");

export function migrate(db: DatabaseSync): void {
	const current = db.prepare("PRAGMA user_version").get() as { user_version: number };
	if (current.user_version >= MIGRATION_VERSION) return;
	const sql = readFileSync(schemaPath, "utf8");
	db.exec(sql);
	db.exec(`PRAGMA user_version = ${MIGRATION_VERSION}`);
}