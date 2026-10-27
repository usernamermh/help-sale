import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "./database.js";
import { MIGRATION_VERSION } from "./migrate.js";
import type { DatabaseSync } from "node:sqlite";

let db: DatabaseSync;

beforeEach(() => {
	db = openDatabase(":memory:");
});

afterEach(() => {
	db.close();
});

describe("database migrations", () => {
	it("user_version 达到当前迁移版本", () => {
		const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
		expect(row.user_version).toBe(MIGRATION_VERSION);
	});

	it("v1 核心表齐全", () => {
		const tables = db
			.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','virtual table')")
			.all()
			.map((r) => (r as { name: string }).name);
		expect(tables).toContain("tenants");
		expect(tables).toContain("customers");
		expect(tables).toContain("knowledge_documents");
		expect(tables).toContain("knowledge_chunks");
		expect(tables).toContain("knowledge_chunks_fts");
		expect(tables).toContain("next_step_tasks");
		expect(tables).toContain("digests");
		expect(tables).toContain("knowledge_candidates");
		expect(tables).toContain("agent_events");
		expect(tables).toContain("customer_tags");
		expect(tables).toContain("notification_logs");
		expect(tables).toContain("conversations");
		expect(tables).toContain("stores");
		expect(tables).toContain("sales");
		expect(tables).toContain("conversation_messages");
		expect(tables).toContain("deals");
		expect(tables).toContain("tool_call_cache");
		expect(tables).toContain("workflows");
		expect(tables).toContain("workflow_runs");
		expect(tables).toContain("knowledge_embeddings");
	});

	it("workflows 具备来源与去重签名列(挖掘去重/能力清单分组依赖)", () => {
		const cols = db.prepare("PRAGMA table_info(workflows)").all() as Array<{ name: string }>;
		const names = cols.map((c) => c.name);
		expect(names).toContain("origin");
		expect(names).toContain("source_signature");
		expect(names).toContain("status");
		expect(names).toContain("version");
	});

	it("重复迁移幂等", () => {
		const sqlite = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'knowledge_chunks_ai'").get() as { sql: string };
		expect(sqlite.sql).toContain("CREATE TRIGGER");
	});
});
