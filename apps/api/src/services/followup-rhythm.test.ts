import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../db/database.js";
import { requireTenant, upsertCustomer } from "../repositories/customers.js";
import { listTasks } from "../repositories/tasks.js";
import { createTestDrive, listTestDrives, setTestDriveStatus } from "../repositories/test-drives.js";
import { scheduleTestDriveFollowups, scheduleDeliveryFollowups } from "./followup-rhythm.js";

let db: DatabaseSync;
beforeEach(() => {
	db = openDatabase(":memory:");
	requireTenant(db, "t1", "演示租户");
});
afterEach(() => db.close());

describe("试驾与回访节奏", () => {
	it("试驾创建/列表/完成", () => {
		const c = upsertCustomer(db, { tenantId: "t1", key: "c_1", name: "王总" });
		const td = createTestDrive(db, { tenantId: "t1", customerId: c.id, scheduledAt: "2026-09-20T10:00:00Z" });
		expect(td.status).toBe("scheduled");
		expect(listTestDrives(db, "t1")).toHaveLength(1);
		const done = setTestDriveStatus(db, "t1", td.id, "completed", "体验很好,对比 Model Y");
		expect(done!.status).toBe("completed");
		expect(done!.feedback).toContain("Model Y");
	});

	it("试驾完成后生成 24h/3d/7d 三段回访任务", () => {
		const c = upsertCustomer(db, { tenantId: "t1", key: "c_1", name: "王总" });
		const actions = scheduleTestDriveFollowups(db, "t1", c.id, "2026-09-20T10:00:00Z");
		expect(actions).toHaveLength(3);
		expect(actions[0]).toContain("24小时");
		expect(actions[1]).toContain("3天");
		expect(actions[2]).toContain("7天");
		const tasks = listTasks(db, { tenantId: "t1", status: "pending" });
		expect(tasks).toHaveLength(3);
		const dueDates = tasks.map((t) => t.dueAt).filter(Boolean).sort();
		expect(dueDates[0]).toBe("2026-09-21T10:00:00.000Z");
	});

	it("提车后生成关怀回访(3天)与保养提醒(30天)", () => {
		const c = upsertCustomer(db, { tenantId: "t1", key: "c_1", name: "王总" });
		const actions = scheduleDeliveryFollowups(db, "t1", c.id, "2026-09-10T00:00:00Z");
		expect(actions).toHaveLength(2);
		expect(actions[0]).toContain("提车关怀");
		expect(actions[1]).toContain("保养提醒");
		const tasks = listTasks(db, { tenantId: "t1", status: "pending" });
		expect(tasks.map((t) => t.action)).toEqual(actions);
	});
});