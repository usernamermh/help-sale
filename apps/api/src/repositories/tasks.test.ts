import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../db/database.js";
import { requireTenant, upsertCustomer } from "./customers.js";
import { createTask, listTasks, setTaskStatus, type TaskRecord } from "./tasks.js";

let db: DatabaseSync;
let customerId: string;

beforeEach(() => {
	db = openDatabase(":memory:");
	requireTenant(db, "t1", "演示租户");
	customerId = upsertCustomer(db, { tenantId: "t1", key: "c_001", name: "王经理" }).id;
});

afterEach(() => db.close());

describe("tasks", () => {
	it("创建后读回字段完整", () => {
		const task = createTask(db, {
			tenantId: "t1",
			customerId,
			analysisId: "an-1",
			action: "发送价格方案",
			dueAt: "2026-09-01T08:00:00Z",
		});
		expect(task.id).toBeTruthy();
		expect(task.status).toBe("pending");
		expect(task.dueAt).toBe("2026-09-01T08:00:00Z");
	});

	it("按 due_before 过滤到期任务", () => {
		createTask(db, { tenantId: "t1", customerId, action: "早任务", dueAt: "2026-08-01T08:00:00Z" });
		createTask(db, { tenantId: "t1", customerId, action: "晚任务", dueAt: "2026-12-01T08:00:00Z" });
		createTask(db, { tenantId: "t1", customerId, action: "无期限任务" });
		const due = listTasks(db, { tenantId: "t1", status: "pending", dueBefore: "2026-09-01T00:00:00Z" });
		expect(due.map((t: TaskRecord) => t.action).slice().sort()).toEqual(["无期限任务", "早任务"]);
	});

	it("完成状态变更并记录时间", () => {
		const task = createTask(db, { tenantId: "t1", customerId, action: "发案例" });
		const done = setTaskStatus(db, "t1", task.id, "done");
		expect(done?.status).toBe("done");
		expect(done?.completedAt).toBeTruthy();
	});

	it("跨租户隔离", () => {
		requireTenant(db, "t2", "另一租户");
		const other = upsertCustomer(db, { tenantId: "t2", key: "c_999" });
		createTask(db, { tenantId: "t1", customerId, action: "t1任务" });
		createTask(db, { tenantId: "t2", customerId: other.id, action: "t2任务" });
		expect(listTasks(db, { tenantId: "t1" })).toHaveLength(1);
		expect(listTasks(db, { tenantId: "t2" })).toHaveLength(1);
	});

	it("列表返回客户标识", () => {
		createTask(db, { tenantId: "t1", customerId, action: "回访" });
		const rows = listTasks(db, { tenantId: "t1" });
		expect(rows[0].customerKey).toBe("c_001");
		expect(rows[0].customerName).toBe("王经理");
	});
});