import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../db/database.js";
import { requireTenant, upsertCustomer } from "../repositories/customers.js";
import { createAnalysis } from "../repositories/analyses.js";
import { createCandidate, rejectCandidate } from "../repositories/knowledge-candidates.js";
import { collectImprovements } from "./improvements.js";

let db: DatabaseSync;
let customerId: string;

beforeEach(() => {
	db = openDatabase(":memory:");
	requireTenant(db, "t1", "演示租户");
	customerId = upsertCustomer(db, { tenantId: "t1", key: "c_001" }).id;
});

afterEach(() => db.close());

describe("collectImprovements", () => {
	it("聚合流失风险场景与被拒候选,输出改进建议", () => {
		createAnalysis(db, { tenantId: "t1", customerId, conversationId: "c1", intent: "价格异议", summary: "s", signals: [{ kind: "risk" }, { kind: "budget" }], suggestedReply: "r", nextSteps: [] });
		createAnalysis(db, { tenantId: "t1", customerId, conversationId: "c2", intent: "价格异议", summary: "s", signals: [{ kind: "risk" }], suggestedReply: "r", nextSteps: [] });
		createAnalysis(db, { tenantId: "t1", customerId, conversationId: "c3", intent: "需求确认", summary: "s", signals: [{ kind: "buying_signal" }], suggestedReply: "r", nextSteps: [] });
		const c = createCandidate(db, { tenantId: "t1", analysisId: "an1", intent: "价格异议", draftTitle: "话术·价格异议", draftContent: "x" });
		rejectCandidate(db, "t1", c.id);

		const out = collectImprovements(db, { tenantId: "t1", days: 30, now: new Date() });
		expect(out.analyses).toBe(3);
		expect(out.rejectedCandidates).toBe(1);
		const risk = out.suggestions.find((s) => s.topic.includes("价格异议"));
		expect(risk?.count).toBe(2);
		expect(out.suggestions.some((s) => s.topic === "知识沉淀流失")).toBe(true);
	});

	it("空数据返回零值与空建议", () => {
		const out = collectImprovements(db, { tenantId: "t1", now: new Date() });
		expect(out.analyses).toBe(0);
		expect(out.suggestions).toEqual([]);
	});
});