import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../db/database.js";
import { requireTenant, upsertCustomer } from "../repositories/customers.js";
import { createTask } from "../repositories/tasks.js";
import { createMemoryReminderQueue } from "../integrations/reminder-queue.js";
import { listNotificationLogs } from "../repositories/notification-logs.js";
import { notifyOverdue } from "./notifications.js";

let db: DatabaseSync;
let customerId: string;

beforeEach(() => {
	db = openDatabase(":memory:");
	requireTenant(db, "t1", "演示租户");
	customerId = upsertCustomer(db, { tenantId: "t1", key: "c_001", name: "王经理" }).id;
});

afterEach(() => db.close());

describe("notifyOverdue", () => {
	it("推送到期任务,写日志,且去重", async () => {
		const reminders = createMemoryReminderQueue();
		const task = createTask(db, { tenantId: "t1", customerId, action: "回访", dueAt: "2020-01-01T00:00:00Z" });
		await reminders.add(task.id, Date.parse(task.dueAt!));

		let received: unknown;
		const fetchImpl = (async (_url: string, init?: RequestInit) => {
			received = JSON.parse(String(init?.body));
			return new Response("ok", { status: 200 });
		}) as typeof fetch;

		const first = await notifyOverdue(db, { tenantId: "t1", reminders, webhookUrl: "http://hook.test/x", fetchImpl });
		expect(first.newlyNotified).toEqual([task.id]);
		expect(first.pushed).toBe(true);
		expect(received).toMatchObject({ type: "overdue_reminder" });

		const logs = listNotificationLogs(db, "t1");
		expect(logs).toHaveLength(1);
		expect(logs[0].status).toBe("sent");

		// 第二次触发:已通知,不重复推送
		const second = await notifyOverdue(db, { tenantId: "t1", reminders, webhookUrl: "http://hook.test/x", fetchImpl });
		expect(second.newlyNotified).toEqual([]);
		expect(second.skipped).toContain(task.id);
		expect(listNotificationLogs(db, "t1")).toHaveLength(1);
	});

	it("webhook 失败时标记 failed 并仍记录", async () => {
		const reminders = createMemoryReminderQueue();
		const task = createTask(db, { tenantId: "t1", customerId, action: "回访", dueAt: "2020-01-01T00:00:00Z" });
		await reminders.add(task.id, Date.parse(task.dueAt!));
		const fetchImpl = (async () => {
			throw new Error("boom");
		}) as typeof fetch;

		const out = await notifyOverdue(db, { tenantId: "t1", reminders, webhookUrl: "http://hook.test/x", fetchImpl });
		expect(out.status).toBe("failed");
		expect(out.reason).toContain("boom");
		const logs = listNotificationLogs(db, "t1");
		expect(logs[0].status).toBe("failed");
	});

	it("无 webhookUrl 时不推送只记录", async () => {
		const reminders = createMemoryReminderQueue();
		const task = createTask(db, { tenantId: "t1", customerId, action: "回访", dueAt: "2020-01-01T00:00:00Z" });
		await reminders.add(task.id, Date.parse(task.dueAt!));
		const out = await notifyOverdue(db, { tenantId: "t1", reminders });
		expect(out.pushed).toBe(false);
		expect(out.status).toBe("sent");
		const logs = listNotificationLogs(db, "t1");
		expect(logs[0].channel).toBe("internal");
	});
});