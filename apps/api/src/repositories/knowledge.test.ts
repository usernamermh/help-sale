import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../db/database.js";
import { requireTenant } from "./customers.js";
import { findDocumentByTitle, insertKnowledgeDocument, searchKnowledge } from "./knowledge.js";

let db: DatabaseSync;

beforeEach(() => {
	db = openDatabase(":memory:");
	requireTenant(db, "t1", "演示租户");
});

afterEach(() => db.close());

describe("knowledge", () => {
	it("插入文档后标题可查到", () => {
		const { documentId } = insertKnowledgeDocument(db, {
			tenantId: "t1",
			title: "价格政策",
			chunks: ["标准版 999 元/年", "旗舰版 1999 元/年"],
		});
		expect(findDocumentByTitle(db, "t1", "价格政策")?.id).toBe(documentId);
	});

	it("FTS 命中中文内容", () => {
		insertKnowledgeDocument(db, { tenantId: "t1", title: "话术", chunks: ["当客户说太贵,先复述他的顾虑再讲 ROI。"] });
		const hits = searchKnowledge(db, "t1", "太贵", 5);
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0].title).toBe("话术");
	});

	it("短词回退 LIKE", () => {
		insertKnowledgeDocument(db, { tenantId: "t1", title: "报价", chunks: ["年度订阅 9999 元。"] });
		const hits = searchKnowledge(db, "t1", "9999", 5);
		expect(hits.length).toBe(1);
	});

	it("多词查询按词拆解命中", () => {
		insertKnowledgeDocument(db, {
			tenantId: "t1",
			title: "价格政策",
			chunks: ["旗舰版 1999 元/年,包含私有化部署与专属客服", "标准版 999 元/年"],
		});
		const hits = searchKnowledge(db, "t1", "旗舰版 价格 预算", 5);
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0].title).toBe("价格政策");
	});
});