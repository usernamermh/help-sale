import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../db/database.js";
import { requireTenant } from "../repositories/customers.js";
import { createAutomationJob, deleteAutomationJob, listAutomationJobs, updateAutomationJob } from "../repositories/automation-jobs.js";
import { listNotificationLogs } from "../repositories/notification-logs.js";
import { runDueAutomations, type AutomationConfig } from "./automation.js";

let db: DatabaseSync;
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

describe("自定义定时任务", () => {
	it("CRUD:创建/编辑/列表/删除", () => {
		const job = createAutomationJob(db, { tenantId: "t1", name: "午间提醒", scheduleType: "daily", scheduleTime: "12:00", description: "提醒销售午间跟进", action: { kind: "notify", title: "午间提醒", content: "该回访了" } });
		expect(job.enabled).toBe(true);
		expect(listAutomationJobs(db, "t1")).toHaveLength(1);

		const updated = updateAutomationJob(db, "t1", job.id, { scheduleTime: "13:00", enabled: false })!;
		expect(updated.scheduleTime).toBe("13:00");
		expect(updated.enabled).toBe(false);

		expect(deleteAutomationJob(db, "t1", job.id)).toBe(true);
		expect(listAutomationJobs(db, "t1")).toHaveLength(0);
		expect(deleteAutomationJob(db, "t1", job.id)).toBe(false);
	});

	it("调度:每日自定义任务到点执行并写通知,已执行当天不重复", () => {
		const job = createAutomationJob(db, { tenantId: "t1", name: "每日播报", scheduleTime: "12:00", action: { kind: "notify", title: "每日播报", content: "hello" } });
		// 12:10 到点(周一)
		const runs = runDueAutomations({ db, config }, new Date("2026-09-14T12:10:00Z"));
		const custom = runs.filter((r) => r.jobType === `custom:${job.id}`);
		expect(custom).toHaveLength(1);
		expect(custom[0].status).toBe("success");
		const logs = listNotificationLogs(db, "t1");
		expect(logs.some((l) => l.title.includes("每日播报"))).toBe(true);

		// 同日再次执行不重复
		const again = runDueAutomations({ db, config }, new Date("2026-09-14T12:20:00Z"));
		expect(again.filter((r) => r.jobType === `custom:${job.id}`)).toHaveLength(0);
	});

	it("调度:停用的自定义任务不执行", () => {
		const job = createAutomationJob(db, { tenantId: "t1", name: "停用任务", scheduleTime: "12:00", enabled: false });
		const runs = runDueAutomations({ db, config }, new Date("2026-09-14T12:10:00Z"));
		expect(runs.some((r) => r.jobType === `custom:${job.id}`)).toBe(false);
	});
});