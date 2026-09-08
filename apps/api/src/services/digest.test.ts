import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../db/database.js";
import { requireTenant, upsertCustomer } from "../repositories/customers.js";
import { createTask } from "../repositories/tasks.js";
import { createAnalysis } from "../repositories/analyses.js";
import { createVehiclePlan } from "../repositories/vehicle-plans.js";
import { collectDigest } from "./digest.js";

let db: DatabaseSync;
let customerId: string;

beforeEach(() => {
	db = openDatabase(":memory:");
	requireTenant(db, "t1", "演示租户");
	customerId = upsertCustomer(db, { tenantId: "t1", key: "c_001", name: "王经理" }).id;
});

afterEach(() => db.close());

describe("collectDigest", () => {
	it("统计待办/到期/分析/方案与意图分布", () => {
		createTask(db, { tenantId: "t1", customerId, action: "发价格方案", dueAt: "2020-01-01T00:00:00Z" });
		createTask(db, { tenantId: "t1", customerId, action: "约试驾", dueAt: "2099-01-01T00:00:00Z" });
		createTask(db, { tenantId: "t1", customerId, action: "回访" });
		createAnalysis(db, {
			tenantId: "t1",
			customerId,
			conversationId: "conv-1",
			intent: "价格异议",
			summary: "s",
			signals: [],
			suggestedReply: "r",
			nextSteps: ["n"],
		});
		createVehiclePlan(db, {
			tenantId: "t1",
			customerId,
			conversationId: "conv-2",
			requirement: "{}",
			planJson: "{}",
		});

		const out = collectDigest(db, { tenantId: "t1", now: new Date() });
		expect(out.stats.pendingTasks).toBe(3);
		expect(out.stats.overdueTasks).toBe(1);
		expect(out.stats.analyses24h).toBe(1);
		expect(out.stats.vehiclePlans7d).toBe(1);
		expect(out.stats.customers).toBe(1);
		expect(out.stats.topIntents[0]).toEqual({ intent: "价格异议", count: 1 });
		expect(out.stats.priorityTasks[0]).toMatchObject({ customer: "王经理", overdue: true });
		expect(out.content).toContain("销售军师晨报");
		expect(out.content).toContain("⚠️ 已到期");
	});

	it("完全空数据时生成可读晨报", () => {
		const out = collectDigest(db, { tenantId: "t1", now: new Date() });
		expect(out.stats.pendingTasks).toBe(0);
		expect(out.content).toContain("暂无待跟进任务");
		expect(out.content).toContain("暂无分析数据");
	});
});