import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../db/database.js";
import { requireTenant, upsertCustomer } from "../repositories/customers.js";
import { createTask, setTaskStatus } from "../repositories/tasks.js";
import { createAnalysis } from "../repositories/analyses.js";
import { createVehiclePlan } from "../repositories/vehicle-plans.js";
import { collectInsights } from "./insights.js";

let db: DatabaseSync;
let customerId: string;

beforeEach(() => {
	db = openDatabase(":memory:");
	requireTenant(db, "t1", "演示租户");
	customerId = upsertCustomer(db, { tenantId: "t1", key: "c_001" }).id;
});

afterEach(() => db.close());

describe("collectInsights", () => {
	it("聚合分析量/意图/任务完成率/车型品牌", () => {
		createAnalysis(db, { tenantId: "t1", customerId, conversationId: "c1", intent: "价格异议", summary: "s", signals: [], suggestedReply: "r", nextSteps: [] });
		createAnalysis(db, { tenantId: "t1", customerId, conversationId: "c2", intent: "价格异议", summary: "s", signals: [], suggestedReply: "r", nextSteps: [] });
		createAnalysis(db, { tenantId: "t1", customerId, conversationId: "c3", intent: "需求确认", summary: "s", signals: [], suggestedReply: "r", nextSteps: [] });
		const t1 = createTask(db, { tenantId: "t1", customerId, action: "a" });
		createTask(db, { tenantId: "t1", customerId, action: "b" });
		setTaskStatus(db, "t1", t1.id, "done");
		createVehiclePlan(db, {
			tenantId: "t1",
			customerId,
			conversationId: "c4",
			requirement: "{}",
			planJson: JSON.stringify({ recommendations: [{ brand: "比亚迪" }, { brand: "特斯拉" }] }),
		});

		const out = collectInsights(db, { tenantId: "t1", now: new Date() });
		expect(out.analyses).toBe(3);
		expect(out.topIntents[0]).toEqual({ intent: "价格异议", count: 2 });
		expect(out.pendingTasks).toBe(1);
		expect(out.taskCompletionRate).toBe(0.5);
		expect(out.vehiclePlans).toBe(1);
		expect(out.topBrands[0]).toEqual({ brand: "比亚迪", count: 1 });
		expect(out.analysesByDay.length).toBeGreaterThanOrEqual(1);
	});

	it("空数据返回零值", () => {
		const out = collectInsights(db, { tenantId: "t1", now: new Date() });
		expect(out.analyses).toBe(0);
		expect(out.taskCompletionRate).toBe(0);
		expect(out.topBrands).toEqual([]);
	});
});