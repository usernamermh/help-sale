import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../db/database.js";
import { requireTenant } from "../repositories/customers.js";
import { createAutomationJob, deleteAutomationJob, listAutomationJobs, updateAutomationJob } from "../repositories/automation-jobs.js";
import { setBuiltinJobEnabled } from "../repositories/builtin-job-settings.js";
import { listNotificationLogs } from "../repositories/notification-logs.js";
import { runDueAutomations, type AutomationConfig } from "./automation.js";

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
		const runs = runDueAutomations({ db, store: stubStore, config }, new Date("2026-09-14T12:10:00Z"));
		const custom = runs.filter((r) => r.jobType === `custom:${job.id}`);
		expect(custom).toHaveLength(1);
		expect(custom[0].status).toBe("success");
		const logs = listNotificationLogs(db, "t1");
		expect(logs.some((l) => l.title.includes("每日播报"))).toBe(true);

		// 同日再次执行不重复
		const again = runDueAutomations({ db, store: stubStore, config }, new Date("2026-09-14T12:20:00Z"));
		expect(again.filter((r) => r.jobType === `custom:${job.id}`)).toHaveLength(0);
	});

	it("调度:停用的自定义任务不执行", () => {
		const job = createAutomationJob(db, { tenantId: "t1", name: "停用任务", scheduleTime: "12:00", enabled: false });
		const runs = runDueAutomations({ db, store: stubStore, config }, new Date("2026-09-14T12:10:00Z"));
		expect(runs.some((r) => r.jobType === `custom:${job.id}`)).toBe(false);
	});
});

	it("间隔任务:每 N 天执行,未满间隔不重复", () => {
		const job = createAutomationJob(db, { tenantId: "t1", name: "每3天报告", scheduleType: "interval", intervalDays: 3, scheduleTime: "09:00", action: { kind: "notify", title: "报告", content: "x" } });
		// 首次执行(无历史):到点触发
		const first = runDueAutomations({ db, store: stubStore, config }, new Date("2026-09-14T09:10:00Z"));
		expect(first.some((r) => r.jobType === `custom:${job.id}`)).toBe(true);
		// 间隔未满(1 天后):不触发
		const next = runDueAutomations({ db, store: stubStore, config }, new Date("2026-09-15T09:10:00Z"));
		expect(next.some((r) => r.jobType === `custom:${job.id}`)).toBe(false);
		// 满 3 天:再次触发
		const third = runDueAutomations({ db, store: stubStore, config }, new Date("2026-09-17T09:10:00Z"));
		expect(third.some((r) => r.jobType === `custom:${job.id}`)).toBe(true);
	});

	it("Agent 目标任务:到点触发并记录 running(由 Agent 后台执行)", () => {
		const job = createAutomationJob(db, { tenantId: "t1", name: "自动报告", scheduleTime: "10:00", action: { kind: "agent_goal", goal: "生成近3天经营报告" } });
		const runs = runDueAutomations({ db, store: stubStore, config }, new Date("2026-09-14T10:10:00Z"));
		const custom = runs.find((r) => r.jobType === `custom:${job.id}`);
		expect(custom).toBeTruthy();
		expect(custom!.status).toBe("running");
		const record = db.prepare("SELECT status, summary FROM automation_runs WHERE job_type = ? ORDER BY created_at DESC LIMIT 1").get(`custom:${job.id}`) as { status: string; summary: string };
		expect(record.status).toBe("running");
	});

	it("内置任务开关:停用后不再触发", () => {
		setBuiltinJobEnabled(db, "t1", "morning_digest", false);
		const runs = runDueAutomations({ db, store: stubStore, config }, new Date("2026-09-14T08:10:00Z"));
		expect(runs.some((r) => r.jobType === "morning_digest")).toBe(false);
		setBuiltinJobEnabled(db, "t1", "morning_digest", true);
		const runs2 = runDueAutomations({ db, store: stubStore, config }, new Date("2026-09-15T08:10:00Z"));
		expect(runs2.some((r) => r.jobType === "morning_digest")).toBe(true);
	});

	it("间隔小时任务:满 N 小时再次执行,未满不触发", () => {
		const job = createAutomationJob(db, { tenantId: "t1", name: "每2小时检查", scheduleType: "interval", intervalDays: 2, intervalUnit: "hour", scheduleTime: "00:00", action: { kind: "notify", title: "检查", content: "x" } });
		// 首次触发
		const first = runDueAutomations({ db, store: stubStore, config }, new Date("2026-09-14T10:00:00Z"));
		expect(first.some((r) => r.jobType === `custom:${job.id}`)).toBe(true);
		// 把执行记录时间对齐到测试时间(created_at 由真实时钟生成)
		db.prepare("UPDATE automation_runs SET created_at = ? WHERE job_type = ?").run("2026-09-14T10:00:00Z", `custom:${job.id}`);
		// 1 小时后未满 2 小时:不触发
		const soon = runDueAutomations({ db, store: stubStore, config }, new Date("2026-09-14T11:00:00Z"));
		expect(soon.some((r) => r.jobType === `custom:${job.id}`)).toBe(false);
		// 满 2 小时后:再次触发
		const later = runDueAutomations({ db, store: stubStore, config }, new Date("2026-09-14T12:30:00Z"));
		expect(later.some((r) => r.jobType === `custom:${job.id}`)).toBe(true);
	});