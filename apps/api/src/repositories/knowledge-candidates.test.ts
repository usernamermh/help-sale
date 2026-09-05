import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../db/database.js";
import { requireTenant } from "./customers.js";
import { findDocumentByTitle } from "./knowledge.js";
import { approveCandidate, createCandidate, listCandidates, rejectCandidate } from "./knowledge-candidates.js";

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

	it("approve 入库并标记,同名文档复用", async () => {
		const c = createCandidate(db, { tenantId: "t1", analysisId: "an-1", intent: "价格异议", draftTitle: "话术·价格异议", draftContent: "内容A" });
		const approved = approveCandidate(db, "t1", c.id);
		expect(approved?.status).toBe("approved");
		expect(approved?.documentId).toBeTruthy();
		expect(findDocumentByTitle(db, "t1", "话术·价格异议")).toBeTruthy();

		// 同 title 再次通过:不新增文档,复用
		const c2 = createCandidate(db, { tenantId: "t1", analysisId: "an-2", intent: "价格异议", draftTitle: "话术·价格异议", draftContent: "内容B" });
		const approved2 = approveCandidate(db, "t1", c2.id);
		expect(approved2?.status).toBe("approved");
		const docs = db.prepare("SELECT COUNT(*) AS n FROM knowledge_documents").get() as { n: number };
		expect(docs.n).toBe(1);
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