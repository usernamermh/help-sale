import type { DatabaseSync } from "node:sqlite";
import { collectDigest } from "./digest.js";
import { collectWeeklyReport } from "./weekly-report.js";
import { createDigest, getDigestByDate } from "../repositories/digests.js";
import { listSilentCustomers } from "../repositories/funnel.js";
import { createTask } from "../repositories/tasks.js";
import { applyReflectionToMemory } from "./reflection.js";
import { createNotificationLog } from "../repositories/notification-logs.js";
import { getCustomer } from "../repositories/customers.js";
import { hasAutomationRunOn, listTenantIds, recordAutomationRun, type AutomationJobType } from "../repositories/automation-runs.js";

export interface AutomationConfig {
	enabled: boolean;
	morningDigestTime: string;
	weeklyReportWeekday: number;
	weeklyReportTime: string;
	silentCustomerDays: number;
	silentWakeupEnabled: boolean;
	wakeupTaskTime: string;
}

export interface AutomationDeps {
	db: DatabaseSync;
	config: AutomationConfig;
}

const MINUTE_MS = 60 * 1000;

function dateKey(d: Date): string {
	return d.toISOString().slice(0, 10);
}

function timeToMinutes(time: string): number {
	const [h, m] = time.split(":").map(Number);
	return (h || 0) * 60 + (m || 0);
}

/** 检查 job 是否在 now 时刻到期(时间已到且当天未执行)。 */
function isDue(db: DatabaseSync, tenantId: string, jobType: AutomationJobType, runDate: string, nowMinutes: number, scheduledMinutes: number): boolean {
	if (nowMinutes < scheduledMinutes) return false;
	return !hasAutomationRunOn(db, tenantId, jobType, runDate);
}


/** 反思闭环:聚合近 N 天反思案例,把改进建议写入 memory「规则改进」小节。 */
function runReflection(db: DatabaseSync, tenantId: string, days: number): string {
	const summary = applyReflectionToMemory(db, tenantId, days);
	if (summary.suggestions.length === 0) return "本周无反思建议";
	return `已将 ${summary.suggestions.length} 条反思建议写入记忆「规则改进」`;
}
/** 晨报:生成并落库(当天已存在则跳过)。 */
function runMorningDigest(db: DatabaseSync, tenantId: string, now: Date): string {
	const date = dateKey(now);
	if (getDigestByDate(db, tenantId, date)) return "晨报当天已存在,跳过";
	const d = collectDigest(db, { tenantId, now });
	createDigest(db, { tenantId, digestDate: date, title: d.title, content: d.content, statsJson: JSON.stringify(d.stats) });
	const summary = `已生成晨报:待办 ${d.stats.pendingTasks} / 到期 ${d.stats.overdueTasks} / 近24h分析 ${d.stats.analyses24h}`;
	createNotificationLog(db, { tenantId, channel: "automation", title: `📰 ${d.title}`, contentJson: JSON.stringify({ summary, content: d.content }), status: "sent" });
	return summary;
}

/** 周报:汇总近 7 天经营数据并落库(复用 digests,标题区分周报)。 */
function runWeeklyReport(db: DatabaseSync, tenantId: string, now: Date): string {
	const r = collectWeeklyReport(db, tenantId, now);
	const key = `weekly-${r.stats.from}-${r.stats.to}`;
	if (getDigestByDate(db, tenantId, key)) return "周报当天已存在,跳过";
	createDigest(db, { tenantId, digestDate: key, title: r.title, content: r.content, statsJson: JSON.stringify(r.stats) });
	const summary = `已生成周报:成交 ${r.stats.deals} 单 / ¥${r.stats.dealAmount.toLocaleString()} / 完成率 ${Math.round(r.stats.taskRate * 100)}%`;
	createNotificationLog(db, { tenantId, channel: "automation", title: `📊 ${r.title}`, contentJson: JSON.stringify({ summary, content: r.content }), status: "sent" });
	return summary;
}

/** 沉默客户唤醒:为近 N 天未跟进客户建唤醒任务(该客户已有 pending 唤醒任务则跳过)。 */
function runSilentWakeup(db: DatabaseSync, tenantId: string, days: number, now: Date): string {
	const silent = listSilentCustomers(db, tenantId, days);
	let created = 0;
	let skipped = 0;
	for (const c of silent) {
		const existing = db
			.prepare(
				`SELECT id FROM next_step_tasks WHERE tenant_id = ? AND customer_id = ? AND status = 'pending' AND action LIKE '唤醒回访%' LIMIT 1`,
			)
			.get(tenantId, c.id);
		if (existing) {
			skipped++;
			continue;
		}
		createTask(db, { tenantId, customerId: c.id, action: `唤醒回访:客户 ${c.name ?? c.key} 近 ${days} 天未跟进,请主动联系`, dueAt: now.toISOString() });
		created++;
	}
	return `沉默客户 ${silent.length} 位:新建唤醒任务 ${created} 条,已有待办跳过 ${skipped} 条`;
}

/** 执行到期自动任务(按租户循环),返回本次执行的记录摘要。 */
export function runDueAutomations(deps: AutomationDeps, now = new Date()): Array<{ tenantId: string; jobType: string; status: string; summary: string }> {
	const { db, config } = deps;
	const out: Array<{ tenantId: string; jobType: string; status: string; summary: string }> = [];
	const nowMinutes = now.getHours() * 60 + now.getMinutes();
	const date = dateKey(now);

	// 周报日:weeklyReportWeekday(1=周一…7=周日),JS getDay():0=周日
	const weekday = now.getDay() === 0 ? 7 : now.getDay();
	const isWeeklyDay = weekday === config.weeklyReportWeekday;

	for (const tenantId of listTenantIds(db)) {
		const jobs: Array<{ type: AutomationJobType; due: boolean; run: () => string }> = [
			{ type: "morning_digest", due: isDue(db, tenantId, "morning_digest", date, nowMinutes, timeToMinutes(config.morningDigestTime)), run: () => runMorningDigest(db, tenantId, now) },
			{ type: "weekly_report", due: isWeeklyDay && isDue(db, tenantId, "weekly_report", date, nowMinutes, timeToMinutes(config.weeklyReportTime)), run: () => runWeeklyReport(db, tenantId, now) },
		{ type: "reflection", due: isWeeklyDay && isDue(db, tenantId, "reflection", date, nowMinutes, timeToMinutes(config.weeklyReportTime) + 30), run: () => runReflection(db, tenantId, 7) },
			{ type: "silent_wakeup", due: config.silentWakeupEnabled && isDue(db, tenantId, "silent_wakeup", date, nowMinutes, timeToMinutes(config.wakeupTaskTime)), run: () => runSilentWakeup(db, tenantId, config.silentCustomerDays, now) },
		];
		for (const job of jobs) {
			if (!job.due) continue;
			try {
				const summary = job.run();
				recordAutomationRun(db, { tenantId, jobType: job.type, runDate: date, status: "success", summary });
				out.push({ tenantId, jobType: job.type, status: "success", summary });
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				recordAutomationRun(db, { tenantId, jobType: job.type, runDate: date, status: "error", summary: msg });
				out.push({ tenantId, jobType: job.type, status: "error", summary: msg });
			}
		}
	}
	return out;
}

/** 启动定时调度器:每分钟 tick 一次;返回 stop 函数(注册到 app.onClose)。 */
export function startAutomationScheduler(deps: AutomationDeps): () => void {
	if (!deps.config.enabled) return () => undefined;
	const timer = setInterval(() => {
		try {
			runDueAutomations(deps);
		} catch (error) {
			console.warn(`[automation] tick 失败: ${error instanceof Error ? error.message : String(error)}`);
		}
	}, MINUTE_MS);
	timer.unref?.();
	return () => clearInterval(timer);
}

/** 手动触发单个任务(忽略时间窗,立即执行并记录)。 */
export function runAutomationJob(db: DatabaseSync, tenantId: string, jobType: AutomationJobType, config: AutomationConfig, now = new Date()): string {
	const date = dateKey(now);
	const run = () => {
		if (jobType === "morning_digest") return runMorningDigest(db, tenantId, now);
		if (jobType === "weekly_report") return runWeeklyReport(db, tenantId, now);
		return runSilentWakeup(db, tenantId, config.silentCustomerDays, now);
	};
	try {
		const summary = run();
		recordAutomationRun(db, { tenantId, jobType, runDate: date, status: "success", summary });
		return summary;
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		recordAutomationRun(db, { tenantId, jobType, runDate: date, status: "error", summary: msg });
		throw error;
	}
}
