import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../db/database.js";
import { requireTenant, upsertCustomer } from "./customers.js";
import { bindAnalysisRequestHash, createAnalysis, findAnalysisByRequestHash, listAnalysesByCustomer } from "./analyses.js";

let db: DatabaseSync;
let customerId: string;

beforeEach(() => {
	db = openDatabase(":memory:");
	requireTenant(db, "t1", "演示租户");
	customerId = upsertCustomer(db, { tenantId: "t1", key: "c_001" }).id;
});

afterEach(() => db.close());

describe("analyses", () => {
	it("创建后可读回,字段完整", () => {
		createAnalysis(db, {
			tenantId: "t1",
			customerId,
			conversationId: "conv-1",
			intent: "价格异议",
			summary: "客户认为贵",
			signals: [{ kind: "budget", note: "提到预算 5000" }],
			suggestedReply: "先共情再讲 ROI",
			nextSteps: ["发案例", "下周二跟进"],
		});
		const list = listAnalysesByCustomer(db, "t1", customerId);
		expect(list).toHaveLength(1);
		expect(list[0].intent).toBe("价格异议");
		expect(list[0].signals).toEqual([{ kind: "budget", note: "提到预算 5000" }]);
	});

	it("多租户隔离", () => {
		requireTenant(db, "t2", "另一租户");
		const other = upsertCustomer(db, { tenantId: "t2", key: "c_001" });
		createAnalysis(db, { tenantId: "t1", customerId, conversationId: "c1", intent: "A", summary: "s", signals: [], suggestedReply: "r", nextSteps: [] });
		createAnalysis(db, { tenantId: "t2", customerId: other.id, conversationId: "c2", intent: "B", summary: "s", signals: [], suggestedReply: "r", nextSteps: [] });
		expect(listAnalysesByCustomer(db, "t1", customerId)).toHaveLength(1);
		expect(listAnalysesByCustomer(db, "t2", other.id)).toHaveLength(1);
	});

	it("请求哈希缓存:绑定后可查,跨租户隔离", () => {
		const a1 = createAnalysis(db, {
			tenantId: "t1", customerId, conversationId: "conv-req",
			intent: "价格异议", summary: "客户嫌贵", signals: [], suggestedReply: "共情", nextSteps: ["发方案"],
		});
		bindAnalysisRequestHash(db, "t1", a1.id, "hash-abc");
		const hit = findAnalysisByRequestHash(db, "t1", "hash-abc");
		expect(hit?.id).toBe(a1.id);
		expect(hit?.intent).toBe("价格异议");

		requireTenant(db, "t2", "另一租户");
		expect(findAnalysisByRequestHash(db, "t2", "hash-abc")).toBeUndefined();
	});
});