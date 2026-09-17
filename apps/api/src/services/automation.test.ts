import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../db/database.js";
import { requireTenant, upsertCustomer } from "../repositories/customers.js";
import { listAutomationRuns } from "../repositories/automation-runs.js";
import { listSilentCustomers } from "../repositories/funnel.js";
import { listTasks } from "../repositories/tasks.js";
import { runDueAutomations, runAutomationJob, type AutomationConfig } from "./automation.js";

let db: DatabaseSync;
const stubStore = {
	createConversation: async () => { throw new Error("not used"); },
	openConversation: async () => { throw new Error("not used"); },
	close: async () => undefined,
} as never;
const config: AutomationConfig = {
	enabled: true,
	morningDigestTime: "08:00",
	weeklyReportWeekday: 1,
	weeklyReportTime: "09:00",
	silentCustomerDays: 7,
	silentWakeupEnabled: true,
	wakeupTaskTime: "08:30",
};

beforeEach(() => {
	db = openDatabase(":memory:");
	requireTenant(db, "t1", "演示租户");
});
afterEach(() => db.close());

describe("定时与主动任务", () => {
	it("每日晨报:到点自动生成并落库,同一天不重复执行", () => {
		const now = new Date("2026-09-14T08:10:00Z");
		const runs = runDueAutomations({ db, store: stubStore, config }, now);
		const digestRuns = runs.filter((r) => r.jobType === "morning_digest");
		expect(digestRuns).toHaveLength(1);
		expect(digestRuns[0].status).toBe("success");
		const rows = listAutomationRuns(db, "t1");
		expect(rows.some((r) => r.jobType === "morning_digest")).toBe(true);

		const again = runDueAutomations({ db, store: stubStore, config }, new Date("2026-09-14T08:20:00Z"));
		expect(again.filter((r) => r.jobType === "morning_digest")).toHaveLength(0);
	});

	it("周报:仅周一到点生成,非周一不生成", () => {
		const monday = runDueAutomations({ db, store: stubStore, config }, new Date("2026-09-14T09:05:00Z")); // 周一
		expect(monday.some((r) => r.jobType === "weekly_report")).toBe(true);
		const tuesday = runDueAutomations({ db, store: stubStore, config }, new Date("2026-09-15T09:05:00Z")); // 周二
		expect(tuesday.some((r) => r.jobType === "weekly_report")).toBe(false);
	});

	it("沉默客户唤醒:到点自动建唤醒任务,已有待办客户不再进入沉默名单", () => {
		upsertCustomer(db, { tenantId: "t1", key: "c_silent", name: "沉默客户" });
		db.prepare("UPDATE customers SET updated_at = datetime('now', '-30 days') WHERE key = 'c_silent'").run();
		const active = upsertCustomer(db, { tenantId: "t1", key: "c_active", name: "活跃客户" });
		db.prepare(
			"INSERT INTO conversations (id, tenant_id, customer_id, sales_name, message_count, updated_at) VALUES (?,?,?,?,?,?)",
		).run("cv1", "t1", active.id, "销售A", 1, new Date().toISOString());

		expect(listSilentCustomers(db, "t1", 7).map((c) => c.key)).toEqual(["c_silent"]);

		const runs = runDueAutomations({ db, store: stubStore, config }, new Date("2026-09-14T08:40:00Z"));
		const wake = runs.find((r) => r.jobType === "silent_wakeup")!;
		expect(wake.status).toBe("success");
		expect(wake.summary).toContain("新建唤醒任务 1 条");

		const tasks = listTasks(db, { tenantId: "t1", status: "pending" });
		expect(tasks.some((t) => t.action.includes("唤醒回访"))).toBe(true);

		// 再次执行:客户已有待办唤醒任务,不再视为沉默,不重复建
		const again = runDueAutomations({ db, store: stubStore, config }, new Date("2026-09-15T08:40:00Z"));
		const wake2 = again.find((r) => r.jobType === "silent_wakeup")!;
		expect(wake2.status).toBe("success");
		expect(wake2.summary).toContain("沉默客户 0 位");
		expect(listTasks(db, { tenantId: "t1", status: "pending" }).filter((t) => t.action.includes("唤醒回访"))).toHaveLength(1);
	});

	it("手动触发:忽略时间窗立即执行并记录", () => {
		const summary = runAutomationJob(db, "t1", "morning_digest", config, new Date("2026-09-15T00:10:00Z"));
		expect(summary).toContain("晨报");
		const runs = listAutomationRuns(db, "t1", 10);
		expect(runs[0].jobType).toBe("morning_digest");
		expect(runs[0].status).toBe("success");
	});
});