import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../db/database.js";
import { requireTenant, upsertCustomer } from "../repositories/customers.js";
import { listAutomationRuns, recordAutomationRun } from "../repositories/automation-runs.js";
import { listSilentCustomers } from "../repositories/funnel.js";
import { listTasks } from "../repositories/tasks.js";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { fauxProvider, fauxToolCall, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createAutomationJob, getAutomationJob } from "../repositories/automation-jobs.js";
import { runAgentGoalJob, runDueAutomations, runAutomationJob, type AutomationConfig } from "./automation.js";

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

	it("晨报执行结果结构化落库:detail_json 含 stats/content", () => {
		runDueAutomations({ db, store: stubStore, config }, new Date("2026-09-14T08:10:00Z"));
		const run = listAutomationRuns(db, "t1").find((r) => r.jobType === "morning_digest")!;
		expect(run.detailJson).toBeTruthy();
		const detail = JSON.parse(run.detailJson!) as { stats?: { pendingTasks?: number }; content?: string };
		expect(detail.stats?.pendingTasks).toBeTypeOf("number");
		expect(detail.content).toContain("销售军师晨报");
	});

	it("沉默客户唤醒执行结果结构化落库:detail_json 含 created/skipped", () => {
		upsertCustomer(db, { tenantId: "t1", key: "c_silent2", name: "沉默客户2" });
		db.prepare("UPDATE customers SET updated_at = datetime('now', '-30 days') WHERE key = 'c_silent2'").run();
		runDueAutomations({ db, store: stubStore, config }, new Date("2026-09-14T08:40:00Z"));
		const run = listAutomationRuns(db, "t1").find((r) => r.jobType === "silent_wakeup")!;
		const detail = JSON.parse(run.detailJson!) as { total: number; created: number; skipped: number };
		expect(detail.total).toBeGreaterThan(0);
		expect(detail.created).toBeGreaterThan(0);
		expect(detail.skipped).toBe(0);
	});

	it("Agent 自主执行任务:完成后结构化结果回填 detail_json", async () => {
		const fa = fauxProvider();
		fa.setResponses([
			fauxAssistantMessage([fauxToolCall("emit_final", { answer: "报告完成", summary: "一句话摘要", nextSteps: ["跟进"] })]),
		]);
		const streamFn: StreamFn = async (model, context, options) => fa.provider.stream(model as never, context, options);
		const run = recordAutomationRun(db, { tenantId: "t1", jobType: "custom:job-1", runDate: "2026-09-14", status: "running", summary: "Agent 任务排队执行" });
		runAgentGoalJob({ db, store: stubStore, config, streamFn } as never, "t1", { id: "job-1", actionJson: JSON.stringify({ kind: "agent_goal", goal: "生成经营报告" }) }, run.id, new Date("2026-09-14T09:00:00Z"));
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline) {
			const cur = listAutomationRuns(db, "t1").find((x) => x.id === run.id)!;
			if (cur.status !== "running") break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		const latest = listAutomationRuns(db, "t1").find((x) => x.id === run.id)!;
		expect(latest.status).toBe("success");
		const detail = JSON.parse(latest.detailJson!) as { answer: string; summary: string; nextSteps: string[] };
		expect(detail.answer).toBe("报告完成");
		expect(detail.summary).toBe("一句话摘要");
		expect(detail.nextSteps).toEqual(["跟进"]);
	});

	it("一次性任务:指定日期到点执行一次,执行后自动停用", () => {
		const job = createAutomationJob(db, {
			tenantId: "t1",
			name: "一次性提醒",
			scheduleType: "once",
			onceDate: "2026-09-14",
			scheduleTime: "10:00",
			action: { kind: "notify", title: "提醒" },
			enabled: true,
		});
		// 非执行日不到点
		expect(runDueAutomations({ db, store: stubStore, config }, new Date("2026-09-13T10:05:00Z")).some((r) => r.jobType === "custom:" + job.id)).toBe(false);
		// 执行日到点执行
		const runs = runDueAutomations({ db, store: stubStore, config }, new Date("2026-09-14T10:05:00Z"));
		expect(runs.some((r) => r.jobType === "custom:" + job.id && r.status === "success")).toBe(true);
		// 执行后自动停用,不再触发
		const after = getAutomationJob(db, "t1", job.id)!;
		expect(after.enabled).toBe(false);
		expect(runDueAutomations({ db, store: stubStore, config }, new Date("2026-09-15T10:05:00Z")).some((r) => r.jobType === "custom:" + job.id)).toBe(false);
	});

	it("手动触发:忽略时间窗立即执行并记录结构化结果", () => {
		const summary = runAutomationJob(db, "t1", "morning_digest", config, new Date("2026-09-15T00:10:00Z"));
		expect(summary).toContain("晨报");
		const runs = listAutomationRuns(db, "t1", 10);
		expect(runs[0].jobType).toBe("morning_digest");
		expect(runs[0].status).toBe("success");
		expect(runs[0].detailJson).toBeTruthy();
	});
});