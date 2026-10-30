import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../../../db/database.js";
import { requireTenant } from "../../../integrations_pi/tables/crm/customers.js";
import { createKanbanTask, updateKanbanCard } from "./kanban.js";
import { hasSubagentWorker, notifySubagentWork, registerSubagentWorker, unregisterSubagentWorker } from "./subagent-signal.js";

let db: DatabaseSync;
let kicks = 0;

beforeEach(() => {
	db = openDatabase(":memory:");
	requireTenant(db, "t1", "演示租户");
	kicks = 0;
	registerSubagentWorker(() => { kicks += 1; });
});

afterEach(() => {
	unregisterSubagentWorker();
	db.close();
});

describe("子代理唤醒信号", () => {
	it("注册后 notify 才有效;注销后不再触发", () => {
		expect(hasSubagentWorker()).toBe(true);
		notifySubagentWork();
		expect(kicks).toBe(1);
		unregisterSubagentWorker();
		expect(hasSubagentWorker()).toBe(false);
		notifySubagentWork();
		expect(kicks).toBe(1);
	});

	it("新建 pending 卡立刻唤醒消费者;非 pending 不唤醒", () => {
		createKanbanTask(db, { tenantId: "t1", threadId: "th1", title: "子任务A", goal: "查客户" });
		expect(kicks).toBe(1);
		createKanbanTask(db, { tenantId: "t1", threadId: "th1", title: "已完成的卡", goal: "x", status: "done" });
		expect(kicks).toBe(1);
	});

	it("把卡改回 pending(重试)同样唤醒", () => {
		const card = createKanbanTask(db, { tenantId: "t1", threadId: "th1", title: "子任务B", goal: "查会话" });
		kicks = 0;
		updateKanbanCard(db, "t1", card.id, { status: "inprogress" });
		expect(kicks).toBe(0);
		updateKanbanCard(db, "t1", card.id, { status: "pending" });
		expect(kicks).toBe(1);
	});
});