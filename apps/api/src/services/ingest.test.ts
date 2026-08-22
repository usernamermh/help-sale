import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../db/database.js";
import { requireTenant } from "../repositories/customers.js";
import { ingestDocument } from "./ingest.js";

let db: DatabaseSync;

beforeEach(() => {
	db = openDatabase(":memory:");
	requireTenant(db, "t1", "演示租户");
});

afterEach(() => db.close());

describe("ingestDocument", () => {
	it("入库并分块", () => {
		const text = "第一段。" + "长".repeat(200) + "\n\n第二段。";
		const result = ingestDocument(db, { tenantId: "t1", title: "产品手册", content: text });
		expect(result.skipped).toBe(false);
		expect(result.chunkCount).toBeGreaterThan(0);
		const rows = db.prepare("SELECT COUNT(*) AS n FROM knowledge_chunks").get() as { n: number };
		expect(rows.n).toBe(result.chunkCount);
	});

	it("同名文档幂等跳过", () => {
		ingestDocument(db, { tenantId: "t1", title: "产品手册", content: "内容一" });
		const again = ingestDocument(db, { tenantId: "t1", title: "产品手册", content: "内容二" });
		expect(again.skipped).toBe(true);
		const rows = db.prepare("SELECT COUNT(*) AS n FROM knowledge_documents").get() as { n: number };
		expect(rows.n).toBe(1);
	});
});