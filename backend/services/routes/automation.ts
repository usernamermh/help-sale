import type { DatabaseSync } from "node:sqlite";
import { collectDigest, collectWeeklyReport, type DigestStats, type WeeklyReport } from "./assistant.js";
import { applyReflectionToMemory, type ReflectionSummary } from "./reflections.js";
import { config } from "../../env.js";
import { createAutomationJob, deleteAutomationJob, getAutomationJob, listAutomationJobs, updateAutomationJob } from "../../integrations_pi/tables/automation/jobs.js";
import { createDigest, getDigestByDate } from "../../integrations_pi/tables/analysis/digests.js";
import { createNotificationLog } from "../../integrations_pi/tables/automation/notifications.js";
import { createTask } from "../../integrations_pi/tables/sales/tasks.js";
import { getBuiltinJobEnabled, setBuiltinJobEnabled } from "../../integrations_pi/tables/automation/builtin-settings.js";
import { getCustomer } from "../../integrations_pi/tables/crm/customers.js";
import { listAutomationRuns, updateAutomationRunStatus, hasAutomationRunOn, listTenantIds, recordAutomationRun, type AutomationRun, type AutomationJobType } from "../../integrations_pi/tables/automation/runs.js";
import { listSilentCustomers } from "../../integrations_pi/tables/crm/funnel.js";
import { runSalesAgent } from "../../integrations_pi/agent-runtime.js";
import type { FastifyInstance } from "fastify";
import type { ModelRuntime } from "../../integrations_pi/models.js";
import type { RouteDeps } from "./helpers.js";
import type { SessionStore } from "../../integrations_pi/sessions.js";
import type { StreamFn } from "@earendil-works/pi-agent-core";

// ── 以下来自 v1 services/automation.ts(功能逻辑与路由同文件) ──
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
	store: SessionStore;
	runtime?: ModelRuntime;
	streamFn?: StreamFn;
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




/** 检查 interval(hour)任务是否到点:距上次执行(created_at)已满 N 小时;无历史则首次到点即可执行。 */
function isHourlyDue(db: DatabaseSync, tenantId: string, jobId: string, now: Date, hours: number): boolean {
	const last = db
		.prepare("SELECT created_at FROM automation_runs WHERE tenant_id = ? AND job_type = ? ORDER BY created_at DESC LIMIT 1")
		.get(tenantId, `custom:${jobId}`) as { created_at: string } | undefined;
	if (!last) return true;
	const lastMs = Date.parse(last.created_at);
	return Number.isFinite(lastMs) && now.getTime() - lastMs >= hours * 3600000;
}
/** 检查 interval(每 N 天)任务是否到点:距上次执行已满 intervalDays 且今天未执行。 */
function isIntervalDue(db: DatabaseSync, tenantId: string, jobId: string, runDate: string, intervalDays: number): boolean {
	if (hasAutomationRunOn(db, tenantId, `custom:${jobId}`, runDate)) return false;
	const last = db
		.prepare("SELECT run_date FROM automation_runs WHERE tenant_id = ? AND job_type = ? ORDER BY run_date DESC LIMIT 1")
		.get(tenantId, `custom:${jobId}`) as { run_date: string } | undefined;
	if (!last) return true; // 从未执行过:到时间即可首次执行
	const lastMs = Date.parse(last.run_date + "T00:00:00Z");
	const dueMs = Date.parse(runDate + "T00:00:00Z");
	return Number.isFinite(lastMs) && Number.isFinite(dueMs) && dueMs - lastMs >= intervalDays * 86400000;
}

/** Agent 目标类自定义任务:到点由 Agent 自主执行(异步),结果回填执行记录。 */
export function runAgentGoalJob(deps: AutomationDeps, tenantId: string, job: { id: string; actionJson: string }, runId: string, now: Date): void {
	const db = deps.db;
	const action = JSON.parse(job.actionJson || "{}") as { kind?: string; goal?: string };
	const goal = String(action.goal ?? "").trim();
	if (!goal) {
		updateAutomationRunStatus(db, tenantId, runId, "error", "agent_goal 缺少 goal");
		return;
	}
	updateAutomationRunStatus(db, tenantId, runId, "running", `Agent 执行中:${goal.slice(0, 60)}…`);
	runSalesAgent({ db, tenantId, store: deps.store, runtime: deps.runtime, streamFn: deps.streamFn }, { goal })
		.then((res) => {
			const final = res.final;
			const answer = final?.answer ?? "";
			const summary = answer ? `Agent 完成:${answer.slice(0, 200)}` : "Agent 完成";
			updateAutomationRunStatus(db, tenantId, runId, "success", summary, {
				answer,
				summary: final?.summary ?? null,
				nextSteps: final?.nextSteps ?? [],
				executedTools: res.executedTools ?? [],
			});
		})
		.catch((error) => {
			updateAutomationRunStatus(db, tenantId, runId, "error", error instanceof Error ? error.message : String(error), { goal: goal.slice(0, 500) });
		});
}
/** 反思闭环:聚合近 N 天反思案例,把改进建议写入 memory「规则改进」小节。 */
function runReflection(db: DatabaseSync, tenantId: string, days: number): { summary: string; detail: { suggestions: ReflectionSummary["suggestions"]; caseCounts: ReflectionSummary["caseCounts"] } } {
	const result = applyReflectionToMemory(db, tenantId, days);
	const summary = result.suggestions.length === 0 ? "本周无反思建议" : `已将 ${result.suggestions.length} 条反思建议写入记忆「规则改进」`;
	return { summary, detail: { suggestions: result.suggestions, caseCounts: result.caseCounts } };
}

/** 自定义任务:到点执行 action(当前支持 notify 通知日志)。 */
export function runCustomJob(db: DatabaseSync, tenantId: string, job: { id: string; name: string; actionJson: string; scheduleType?: string }): string {
	const action = JSON.parse(job.actionJson || "{}") as { kind?: string; title?: string; content?: string };
	const kind = action.kind ?? "notify";
	if (kind === "notify") {
		createNotificationLog(db, {
			tenantId,
			channel: "automation",
			title: action.title ? String(action.title) : `⏰ ${job.name}`,
			contentJson: JSON.stringify({ jobId: job.id, content: action.content ?? "" }),
			status: "sent",
		});
		if (job.scheduleType === "once") db.prepare("UPDATE automation_jobs SET enabled = 0 WHERE id = ?").run(job.id); // 一次性任务手动运行后停用
		return `已触发通知:${action.title ?? job.name}`;
	}
	return `未知自定义任务动作:${kind}`;
}
/** 晨报:生成并落库(当天已存在则跳过)。 */
function runMorningDigest(db: DatabaseSync, tenantId: string, now: Date): { summary: string; detail: { title: string; content: string; stats: DigestStats } } {
	const date = dateKey(now);
	const existing = getDigestByDate(db, tenantId, date);
	if (existing) {
		let stats: DigestStats = { date, pendingTasks: 0, overdueTasks: 0, analyses24h: 0, vehiclePlans7d: 0, customers: 0, topIntents: [], priorityTasks: [] };
		try { stats = JSON.parse(existing.statsJson ?? "{}") as DigestStats; } catch { /* 保持默认 */ }
		return { summary: "晨报当天已存在,跳过", detail: { title: existing.title, content: existing.content, stats } };
	}
	const d = collectDigest(db, { tenantId, now });
	createDigest(db, { tenantId, digestDate: date, title: d.title, content: d.content, statsJson: JSON.stringify(d.stats) });
	const summary = `已生成晨报:待办 ${d.stats.pendingTasks} / 到期 ${d.stats.overdueTasks}`;
	createNotificationLog(db, { tenantId, channel: "automation", title: `📰 ${d.title}`, contentJson: JSON.stringify({ summary, content: d.content }), status: "sent" });
	return { summary, detail: { title: d.title, content: d.content, stats: d.stats } };
}

/** 周报:汇总近 7 天经营数据并落库(复用 digests,标题区分周报)。 */
function runWeeklyReport(db: DatabaseSync, tenantId: string, now: Date): { summary: string; detail: { title: string; content: string; stats: WeeklyReport["stats"] } } {
	const r = collectWeeklyReport(db, tenantId, now);
	const key = `weekly-${r.stats.from}-${r.stats.to}`;
	const existing = getDigestByDate(db, tenantId, key);
	if (existing) {
		let stats: WeeklyReport["stats"] = { from: "", to: "", analyses: 0, deals: 0, dealAmount: 0, taskRate: 0, newCustomers: 0, topIntents: [], topVehicles: [], funnel: [] };
		try { stats = JSON.parse(existing.statsJson ?? "{}") as WeeklyReport["stats"]; } catch { /* 保持默认 */ }
		return { summary: "周报当天已存在,跳过", detail: { title: existing.title, content: existing.content, stats } };
	}
	createDigest(db, { tenantId, digestDate: key, title: r.title, content: r.content, statsJson: JSON.stringify(r.stats) });
	const summary = `已生成周报:成交 ${r.stats.deals} 单 / ¥${r.stats.dealAmount.toLocaleString()} / 完成率 ${Math.round(r.stats.taskRate * 100)}%`;
	createNotificationLog(db, { tenantId, channel: "automation", title: `📊 ${r.title}`, contentJson: JSON.stringify({ summary, content: r.content }), status: "sent" });
	return { summary, detail: { title: r.title, content: r.content, stats: r.stats } };
}

/** 沉默客户唤醒:为近 N 天未跟进客户建唤醒任务(该客户已有 pending 唤醒任务则跳过)。 */
function runSilentWakeup(db: DatabaseSync, tenantId: string, days: number, now: Date): { summary: string; detail: { total: number; created: number; skipped: number } } {
	const silent = listSilentCustomers(db, tenantId, days, undefined, now);
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
	const summary = `沉默客户 ${silent.length} 位:新建唤醒任务 ${created} 条,已有待办跳过 ${skipped} 条`;
	return { summary, detail: { total: silent.length, created, skipped } };
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
		// 自定义定时任务:按 schedule_type(每天/每周/每N天)与时间到点执行;notify 同步,agent_goal 由 Agent 异步自主执行
		for (const job of listAutomationJobs(db, tenantId, true)) {
			let jobDue = false;
			if (job.scheduleType === "interval") jobDue = job.intervalUnit === "hour" ? isHourlyDue(db, tenantId, job.id, now, job.intervalDays ?? 1) : isIntervalDue(db, tenantId, job.id, date, job.intervalDays ?? 1);
			else if (job.scheduleType === "once") jobDue = job.onceDate === date && isDue(db, tenantId, `custom:${job.id}`, date, nowMinutes, timeToMinutes(job.scheduleTime));
			else if (job.scheduleType === "daily") jobDue = isDue(db, tenantId, `custom:${job.id}`, date, nowMinutes, timeToMinutes(job.scheduleTime));
			else jobDue = isWeeklyDay && isDue(db, tenantId, `custom:${job.id}`, date, nowMinutes, timeToMinutes(job.scheduleTime));
			if (!jobDue) continue;
			const actionKind = (() => { try { return (JSON.parse(job.actionJson || "{}") as { kind?: string }).kind ?? "notify"; } catch { return "notify"; } })();
			if (actionKind === "agent_goal") {
				const run = recordAutomationRun(db, { tenantId, jobType: `custom:${job.id}`, runDate: date, status: "running", summary: "Agent 任务排队执行" });
				runAgentGoalJob(deps, tenantId, job, run.id, now);
				if (job.scheduleType === "once") db.prepare("UPDATE automation_jobs SET enabled = 0 WHERE id = ?").run(job.id); // 一次性任务执行后停用
				out.push({ tenantId, jobType: `custom:${job.id}`, status: "running", summary: "Agent 任务已触发,后台执行中" });
				continue;
			}
			try {
				const summary = runCustomJob(db, tenantId, job);
				if (job.scheduleType === "once") db.prepare("UPDATE automation_jobs SET enabled = 0 WHERE id = ?").run(job.id); // 一次性任务执行后停用
				recordAutomationRun(db, { tenantId, jobType: `custom:${job.id}`, runDate: date, status: "success", summary });
				out.push({ tenantId, jobType: `custom:${job.id}`, status: "success", summary });
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				recordAutomationRun(db, { tenantId, jobType: `custom:${job.id}`, runDate: date, status: "error", summary: msg });
				out.push({ tenantId, jobType: `custom:${job.id}`, status: "error", summary: msg });
			}
		}
		const jobs: Array<{ type: AutomationJobType; due: boolean; run: () => { summary: string; detail: Record<string, unknown> } }> = BUILTIN_JOB_META.map((def) => {
			const enabled = getBuiltinJobEnabled(db, tenantId, def.type);
			switch (def.type) {
				case "morning_digest":
					return { type: def.type, due: enabled && isDue(db, tenantId, def.type, date, nowMinutes, timeToMinutes(config.morningDigestTime)), run: () => runMorningDigest(db, tenantId, now) };
				case "weekly_report":
					return { type: def.type, due: enabled && isWeeklyDay && isDue(db, tenantId, def.type, date, nowMinutes, timeToMinutes(config.weeklyReportTime)), run: () => runWeeklyReport(db, tenantId, now) };
				case "silent_wakeup":
					return { type: def.type, due: enabled && config.silentWakeupEnabled && isDue(db, tenantId, def.type, date, nowMinutes, timeToMinutes(config.wakeupTaskTime)), run: () => runSilentWakeup(db, tenantId, config.silentCustomerDays, now) };
				case "reflection":
					return { type: def.type, due: enabled && isWeeklyDay && isDue(db, tenantId, def.type, date, nowMinutes, timeToMinutes(config.weeklyReportTime) + 30), run: () => runReflection(db, tenantId, 7) };
			}
		});
		for (const job of jobs) {
			if (!job.due) continue;
			try {
				const result = job.run();
				recordAutomationRun(db, { tenantId, jobType: job.type, runDate: date, status: "success", summary: result.summary, detail: result.detail });
				out.push({ tenantId, jobType: job.type, status: "success", summary: result.summary });
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
		if (jobType === "reflection") return runReflection(db, tenantId, 7);
		return runSilentWakeup(db, tenantId, config.silentCustomerDays, now);
	};
	try {
		const result = run();
		recordAutomationRun(db, { tenantId, jobType, runDate: date, status: "success", summary: result.summary, detail: result.detail });
		return result.summary;
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		recordAutomationRun(db, { tenantId, jobType, runDate: date, status: "error", summary: msg });
		throw error;
	}
}

// ── 以下来自 v1 services/automation-defs.ts(功能逻辑与路由同文件) ──
/** 内置定时任务唯一数据源:类型/名称/描述在此统一定义,展示时间由配置文件计算,保证界面显示与实际调度一致。 */

export interface BuiltinScheduleConfig {
	morningDigestTime: string;
	weeklyReportWeekday: number;
	weeklyReportTime: string;
	wakeupTaskTime: string;
}

export interface BuiltinJobDef {
	type: BuiltinJobType;
	name: string;
	desc: string;
	schedule: string;
}

export const BUILTIN_JOB_META = [
	{ type: "morning_digest", name: "每日晨报", desc: "自动生成团队晨报:待办/到期任务、近24小时分析量、优先跟进客户,并推送通知日志。" },
	{ type: "weekly_report", name: "每周周报", desc: "汇总近 7 天经营数据:分析量、成交量额、任务完成率、热门意图、车型分布与销售漏斗。" },
	{ type: "silent_wakeup", name: "沉默客户唤醒", desc: "为近 7 天未跟进(无会话/任务/试驾)的客户自动创建「唤醒回访」任务,已有待办自动跳过。" },
	{ type: "reflection", name: "反思改进", desc: "聚合近 7 天反思案例(评估低分/运行失败),把改进建议写入系统记忆「规则改进」,影响后续 Agent 行为。" },
] as const;

export type BuiltinJobType = (typeof BUILTIN_JOB_META)[number]["type"];

export const BUILTIN_JOB_TYPES: readonly BuiltinJobType[] = BUILTIN_JOB_META.map((d) => d.type);

const WEEKDAY_NAMES = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];

function plusMinutes(time: string, minutes: number): string {
	const [h, m] = String(time).split(":").map(Number);
	const total = ((h || 0) * 60 + (m || 0) + minutes) % (24 * 60);
	return String(Math.floor(total / 60)).padStart(2, "0") + ":" + String(total % 60).padStart(2, "0");
}

function scheduleOf(def: (typeof BUILTIN_JOB_META)[number], config: BuiltinScheduleConfig): string {
	const weekday = WEEKDAY_NAMES[config.weeklyReportWeekday] ?? `星期${config.weeklyReportWeekday}`;
	switch (def.type) {
		case "morning_digest":
			return `每天 ${config.morningDigestTime}`;
		case "weekly_report":
			return `每${weekday} ${config.weeklyReportTime}`;
		case "silent_wakeup":
			return `每天 ${config.wakeupTaskTime}`;
		case "reflection":
			// 与调度器一致:反思在周报时间后 30 分钟执行
			return `每${weekday} ${plusMinutes(config.weeklyReportTime, 30)}`;
	}
}

/** 内置任务定义(含展示用时间),时间一律来自配置文件,保证显示与实际调度一致。 */
export function builtinJobDefs(config: BuiltinScheduleConfig): BuiltinJobDef[] {
	return BUILTIN_JOB_META.map((d) => ({ type: d.type, name: d.name, desc: d.desc, schedule: scheduleOf(d, config) }));
}

// automation 域路由(由 v1 routes/list_for_view.ts 拆分而来)

export function registerAutomationRoutes(app: FastifyInstance, deps: RouteDeps): void {
app.get("/api/v1/automations/builtins", async () => ({ defs: builtinJobDefs(config) }));

app.get("/api/v1/automations/builtin", async (request) => {
		const keys = BUILTIN_JOB_TYPES;
		return { settings: Object.fromEntries(keys.map((k) => [k, getBuiltinJobEnabled(deps.db, request.tenantId, k)])) };
	});

app.put<{ Params: { key: string }; Body: { enabled?: boolean } }>("/api/v1/automations/builtin/:key", async (request, reply) => {
		const key = String(request.params.key ?? "");
		if (!(BUILTIN_JOB_TYPES as readonly string[]).includes(key)) {
			return reply.code(400).send({ error: "invalid_key", message: "未知内置任务" });
		}
		const enabled = request.body?.enabled !== false;
		const setting = setBuiltinJobEnabled(deps.db, request.tenantId, key, enabled);
		return { jobKey: key, enabled: setting.enabled };
	});

app.get("/api/v1/automations/jobs", async (request) => {
		return { jobs: listAutomationJobs(deps.db, request.tenantId) };
	});

app.post<{ Body: { name?: string; scheduleType?: string; weekday?: number; intervalDays?: number; intervalUnit?: string; onceDate?: string; scheduleTime?: string; description?: string; action?: unknown; enabled?: boolean } }>("/api/v1/automations/jobs", async (request, reply) => {
		const name = String(request.body?.name ?? "").trim();
		const time = String(request.body?.scheduleTime ?? "").trim();
		if (!name || !/^\d{2}:\d{2}$/.test(time)) {
			return reply.code(400).send({ error: "invalid_input", message: "name 与 scheduleTime(HH:MM) 必填" });
		}
		const weekday = request.body?.weekday;
		if (weekday != null && (weekday < 1 || weekday > 7)) return reply.code(400).send({ error: "invalid_weekday", message: "weekday 取 1-7" });
		const scheduleType = request.body?.scheduleType === "weekly" ? "weekly" : request.body?.scheduleType === "once" ? "once" : request.body?.scheduleType === "interval" ? "interval" : "daily";
		const onceDate = scheduleType === "once" ? String(request.body?.onceDate ?? "").trim() : null;
		if (scheduleType === "once" && !/^\d{4}-\d{2}-\d{2}$/.test(onceDate ?? "")) {
			return reply.code(400).send({ error: "invalid_once_date", message: "指定日期任务需传 onceDate(YYYY-MM-DD)" });
		}
		const job = createAutomationJob(deps.db, {
			tenantId: request.tenantId,
			name,
			scheduleType,
			intervalDays: scheduleType === "interval" ? request.body?.intervalDays ?? 1 : null,
			intervalUnit: scheduleType === "interval" ? (request.body?.intervalUnit === "hour" ? "hour" : "day") : "day",
			onceDate,
			weekday: weekday ?? null,
			scheduleTime: time,
			description: request.body?.description,
			action: request.body?.action,
			enabled: request.body?.enabled,
		});
		return { job };
	});

app.put<{ Params: { id: string }; Body: { name?: string; scheduleType?: string; weekday?: number; intervalDays?: number; intervalUnit?: string; onceDate?: string; scheduleTime?: string; description?: string; action?: unknown; enabled?: boolean } }>("/api/v1/automations/jobs/:id", async (request, reply) => {
		const time = String(request.body?.scheduleTime ?? "").trim();
		if (time && !/^\d{2}:\d{2}$/.test(time)) return reply.code(400).send({ error: "invalid_time", message: "scheduleTime 需 HH:MM" });
		const onceDate = request.body?.onceDate !== undefined ? String(request.body.onceDate ?? "").trim() : undefined;
		if (onceDate !== undefined && onceDate !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(onceDate)) {
			return reply.code(400).send({ error: "invalid_once_date", message: "onceDate 需 YYYY-MM-DD" });
		}
		const job = updateAutomationJob(deps.db, request.tenantId, request.params.id, {
			name: request.body?.name,
			scheduleType: request.body?.scheduleType === "weekly" ? "weekly" : request.body?.scheduleType === "once" ? "once" : request.body?.scheduleType === "interval" ? "interval" : request.body?.scheduleType === "daily" ? "daily" : undefined,
			intervalDays: request.body?.intervalDays,
			intervalUnit: request.body?.intervalUnit === "hour" ? "hour" : request.body?.intervalUnit === "day" ? "day" : undefined,
			onceDate,
			weekday: request.body?.weekday,
			scheduleTime: time || undefined,
			description: request.body?.description,
			action: request.body?.action,
			enabled: request.body?.enabled,
		});
		if (!job) return reply.code(404).send({ error: "job_not_found", message: "任务不存在" });
		return { job };
	});

app.post<{ Params: { id: string } }>("/api/v1/automations/jobs/:id/run", async (request, reply) => {
		const job = getAutomationJob(deps.db, request.tenantId, request.params.id);
		if (!job) return reply.code(404).send({ error: "job_not_found", message: "任务不存在" });
		try {
			const summary = runCustomJob(deps.db, request.tenantId, job);
			return { summary };
		} catch (error) {
			return reply.code(500).send({ error: "job_run_failed", message: error instanceof Error ? error.message : String(error) });
		}
	});

app.delete<{ Params: { id: string } }>("/api/v1/automations/jobs/:id", async (request, reply) => {
		const ok = deleteAutomationJob(deps.db, request.tenantId, request.params.id);
		if (!ok) return reply.code(404).send({ error: "job_not_found", message: "任务不存在" });
		return { deleted: true };
	});

app.get<{ Querystring: { limit?: string } }>("/api/v1/automations", async (request) => {
		const limit = Number.parseInt(request.query.limit ?? "50", 10);
		return { runs: listAutomationRuns(deps.db, request.tenantId, Number.isFinite(limit) ? limit : 50) };
	});

	// ── 定时任务结构化结果 ──

app.get<{ Querystring: { jobType?: string; limit?: string } }>("/api/v1/automations/results", async (request) => {
		const jobTypeFilter = request.query.jobType ? String(request.query.jobType).trim() : "";
		const limit = Math.min(Math.max(Number.parseInt(request.query.limit ?? "50", 10) || 50, 1), 200);
		if (jobTypeFilter) {
			const runs = listAutomationRuns(deps.db, request.tenantId, limit).filter((r) => r.jobType === jobTypeFilter);
			const meta = automationJobMeta(deps.db, request.tenantId, jobTypeFilter);
			return { results: runs.map((r) => automationResult(r.jobType, meta.kind, meta.name, meta.schedule, r)) };
		}
		const runs = listAutomationRuns(deps.db, request.tenantId, 500);
		const latest = new Map<string, AutomationRun>();
		for (const r of runs) if (!latest.has(r.jobType)) latest.set(r.jobType, r);
		const defs = builtinJobDefs(config);
		const results: Array<Record<string, unknown>> = defs.map((d) => automationResult(d.type, "builtin", d.name, d.schedule, latest.get(d.type)));
		for (const job of listAutomationJobs(deps.db, request.tenantId)) {
			results.push(automationResult(`custom:${job.id}`, "custom", job.name, automationScheduleText(job), latest.get(`custom:${job.id}`)));
		}
		return { results };
	});

app.post<{ Body: { job?: string } }>("/api/v1/automations/run", async (request, reply) => {
		const job = String(request.body?.job ?? "");
		if (!(BUILTIN_JOB_TYPES as readonly string[]).includes(job)) {
			return reply.code(400).send({ error: "invalid_job", message: "job 可选 morning_digest/weekly_report/silent_wakeup/reflection" });
		}
		try {
			const summary = runAutomationJob(deps.db, request.tenantId, job as BuiltinJobType, {
				enabled: config.automationEnabled,
				morningDigestTime: config.morningDigestTime,
				weeklyReportWeekday: config.weeklyReportWeekday,
				weeklyReportTime: config.weeklyReportTime,
				silentCustomerDays: config.silentCustomerDays,
				silentWakeupEnabled: config.silentWakeupEnabled,
				wakeupTaskTime: config.wakeupTaskTime,
			});
			return { job, summary };
		} catch (error) {
			return reply.code(500).send({ error: "automation_failed", message: error instanceof Error ? error.message : String(error) });
		}
	});
}

function automationScheduleText(job: { scheduleType: string; intervalDays: number | null; intervalUnit: "day" | "hour"; weekday: number | null; scheduleTime: string; onceDate: string | null }): string {
	if (job.scheduleType === "once") return `一次性 ${job.onceDate ?? ""} ${job.scheduleTime}`;
	if (job.scheduleType === "interval") return job.intervalUnit === "hour" ? `每 ${job.intervalDays ?? 1} 小时 ${job.scheduleTime}` : `每 ${job.intervalDays ?? 1} 天 ${job.scheduleTime}`;
	if (job.scheduleType === "weekly") return `每周${job.weekday ?? 1} ${job.scheduleTime}`;
	return `每天 ${job.scheduleTime}`;
}

function automationJobMeta(db: DatabaseSync, tenantId: string, jobType: string): { kind: string; name: string; schedule: string } {
	const builtin = builtinJobDefs(config).find((d) => d.type === jobType);
	if (builtin) return { kind: "builtin", name: builtin.name, schedule: builtin.schedule };
	if (jobType.startsWith("custom:")) {
		const job = listAutomationJobs(db, tenantId).find((x) => x.id === jobType.slice("custom:".length));
		if (job) return { kind: "custom", name: job.name, schedule: automationScheduleText(job) };
	}
	return { kind: "custom", name: jobType, schedule: "" };
}

function automationResult(jobType: string, kind: string, name: string, schedule: string, run: AutomationRun | undefined): Record<string, unknown> {
	let detail: unknown = null;
	if (run?.detailJson) {
		try {
			detail = JSON.parse(run.detailJson);
		} catch {
			detail = null;
		}
	}
	return {
		jobType,
		kind,
		name,
		schedule,
		runDate: run?.runDate ?? null,
		createdAt: run?.createdAt ?? null,
		status: run?.status ?? null,
		summary: run?.summary ?? null,
		detail,
	};
}
