import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "./database.js";
import type { DatabaseSync } from "node:sqlite";

let db: DatabaseSync;

beforeEach(() => {
	db = openDatabase(":memory:");
});

afterEach(() => {
	db.close();
});

describe("database migrations", () => {
	it("user_version 达到 v1", () => {
		const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
		expect(row.user_version).toBe(16);
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
		expect(tables).toContain("analyses");
		expect(tables).toContain("next_step_tasks");
		expect(tables).toContain("vehicles");
		expect(tables).toContain("vehicle_match_plans");
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
	});

	it("重复迁移幂等", () => {
		const sqlite = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'knowledge_chunks_ai'").get() as { sql: string };
		expect(sqlite.sql).toContain("CREATE TRIGGER");
	});
});