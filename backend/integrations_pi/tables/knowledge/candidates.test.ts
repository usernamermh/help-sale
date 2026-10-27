import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../../../db/database.js";
import { requireTenant } from "../crm/customers.js";
import { findDocumentByTitle } from "./documents.js";
import { approveCandidate, createCandidate, listCandidates, rejectCandidate } from "./candidates.js";

let db: DatabaseSync;

beforeEach(() => {
	db = openDatabase(":memory:");
	requireTenant(db, "t1", "演示租户");
});

afterEach(() => db.close());

describe("knowledge candidates", () => {
	it("创建候选并列表", () => {
		const c = createCandidate(db, {
			tenantId: "t1",
			analysisId: "an-1",
			intent: "价格异议",
			draftTitle: "话术·价格异议",
			draftContent: "理解您的顾虑…",
		});
		expect(c.status).toBe("pending");
		expect(listCandidates(db, "t1", undefined, 50)).toHaveLength(1);
		expect(listCandidates(db, "t1", "approved", 50)).toHaveLength(0);
	});

	it("approve 入库并标记;同名文档走覆盖,文档数量不增", async () => {
		const c = createCandidate(db, { tenantId: "t1", analysisId: "an-1", intent: "价格异议", draftTitle: "话术·价格异议", draftContent: "内容A" });
		// 直接指定建议动作,避免二次确认依赖向量模型
		db.prepare("UPDATE knowledge_candidates SET suggest_action = 'add', review_note = 'test' WHERE id = ?").run(c.id);
		const approved = await approveCandidate(db, "t1", c.id);
		expect(approved?.status).toBe("approved");
		expect(approved?.documentId).toBeTruthy();
		expect(findDocumentByTitle(db, "t1", "话术·价格异议")).toBeTruthy();

		// 同 title 再次通过:建议覆盖,执行后文档仍为 1 份(内容被替换)
		const c2 = createCandidate(db, { tenantId: "t1", analysisId: "an-2", intent: "价格异议", draftTitle: "话术·价格异议", draftContent: "内容B" });
		db.prepare("UPDATE knowledge_candidates SET suggest_action = 'update', old_title = '话术·价格异议', review_note = 'test' WHERE id = ?").run(c2.id);
		const approved2 = await approveCandidate(db, "t1", c2.id);
		expect(approved2?.status).toBe("approved");
		const docs = db.prepare("SELECT COUNT(*) AS n FROM knowledge_documents").get() as { n: number };
		expect(docs.n).toBe(1);
		const doc = db.prepare("SELECT content FROM knowledge_documents WHERE title = ?").get("话术·价格异议") as { content: string };
		expect(doc.content).toContain("内容B");
	});

	it("覆盖更新保留原文档 id 与标题(草稿标题不同也不换名)", async () => {
		const c = createCandidate(db, { tenantId: "t1", analysisId: "an-1", intent: "价格异议", draftTitle: "话术·价格异议", draftContent: "旧版内容" });
		db.prepare("UPDATE knowledge_candidates SET suggest_action = 'add' WHERE id = ?").run(c.id);
		const added = await approveCandidate(db, "t1", c.id);
		const before = db.prepare("SELECT id, title FROM knowledge_documents WHERE tenant_id='t1'").all() as Array<{ id: string; title: string }>;
		expect(before).toHaveLength(1);

		// 后台建议 update,且命中的旧文档标题与草稿标题不同
		const c2 = createCandidate(db, { tenantId: "t1", analysisId: "an-2", intent: "价格异议", draftTitle: "价格异议话术(优化版)", draftContent: "新版内容" });
		db.prepare("UPDATE knowledge_candidates SET suggest_action = 'update', old_title = '话术·价格异议' WHERE id = ?").run(c2.id);
		const updated = await approveCandidate(db, "t1", c2.id);

		const after = db.prepare("SELECT id, title, content FROM knowledge_documents WHERE tenant_id='t1'").all() as Array<{ id: string; title: string; content: string }>;
		expect(after).toHaveLength(1);
		expect(after[0].id).toBe(before[0].id); // 原地更新,不是删旧建新
		expect(after[0].title).toBe("话术·价格异议"); // 保留原标题
		expect(after[0].content).toContain("新版内容");
		expect(updated?.documentId).toBe(before[0].id);
		expect(updated?.reviewNote).toContain("已覆盖");
	});

	it("覆盖时旧文档已不存在则按新增处理", async () => {
		const c = createCandidate(db, { tenantId: "t1", analysisId: "an-1", intent: "竞品对比", draftTitle: "话术·竞品对比", draftContent: "内容X" });
		db.prepare("UPDATE knowledge_candidates SET suggest_action = 'update', old_title = '不存在的老话术' WHERE id = ?").run(c.id);
		const approved = await approveCandidate(db, "t1", c.id);
		expect(findDocumentByTitle(db, "t1", "话术·竞品对比")).toBeTruthy();
		expect(approved?.reviewNote).toContain("未找到旧文档");
	});

	it("reject 标记拒绝", () => {
		const c = createCandidate(db, { tenantId: "t1", analysisId: "an-1", intent: "需求确认", draftTitle: "话术·需求确认", draftContent: "x" });
		const rejected = rejectCandidate(db, "t1", c.id);
		expect(rejected?.status).toBe("rejected");
		expect(listCandidates(db, "t1", "pending", 50)).toHaveLength(0);
	});

	it("跨租户隔离", () => {
		requireTenant(db, "t2", "另一租户");
		createCandidate(db, { tenantId: "t1", analysisId: "an-1", intent: "价格异议", draftTitle: "t1", draftContent: "x" });
		expect(listCandidates(db, "t2", undefined, 50)).toHaveLength(0);
	});
});