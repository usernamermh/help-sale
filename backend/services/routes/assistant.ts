import type { DatabaseSync } from "node:sqlite";
import { config } from "../../env.js";
import { getCustomer } from "../../integrations_pi/tables/crm/customers.js";
import { getDigestByDate, listDigests, createDigest } from "../../integrations_pi/tables/analysis/digests.js";
import { getFunnelStats } from "../../integrations_pi/tables/crm/funnel.js";
import type { FastifyInstance } from "fastify";
import type { RouteDeps } from "./helpers.js";

// ── 以下来自 v1 services/digest.ts(功能逻辑与路由同文件) ──
export interface TaskBriefRow {
	id: string;
	action: string;
	dueAt: string | null;
	customerKey: string | null;
	customerName: string | null;
	status: string;
}

export interface DigestStats {
	/** 分析量/意图分布的数据源(analyses 表)已随"会话分析"功能删除,这里保留字段但恒为 0 / 空 */
	analyses24h: number;
	topIntents: Array<{ intent: string; count: number }>;
	date: string;
	pendingTasks: number;
	overdueTasks: number;
		vehiclePlans7d: number;
	customers: number;	priorityTasks: Array<{
		customer: string;
		action: string;
		dueAt: string | null;
		overdue: boolean;
	}>;
}

export interface DigestOutput {
	title: string;
	content: string;
	stats: DigestStats;
}

/** 采集租户当日统计:待办/到期/最近分析/方案/客户/意图分布/优先跟进。 */
export function collectDigest(db: DatabaseSync, input: { tenantId: string; now?: Date }): DigestOutput {
	const now = input.now ?? new Date();
	const date = now.toISOString().slice(0, 10);

	const pendingRows = db
		.prepare(
			`SELECT t.id, t.action, t.due_at, t.status, c.key AS customer_key, c.name AS customer_name
			 FROM next_step_tasks t
			 LEFT JOIN customers c ON c.id = t.customer_id
			 WHERE t.tenant_id = ? AND t.status = 'pending'
			 ORDER BY (t.due_at IS NULL), t.due_at ASC`,
		)
		.all(input.tenantId) as Array<{
		id: string;
		action: string;
		due_at: string | null;
		status: string;
		customer_key: string | null;
		customer_name: string | null;
	}>;

	const tasks: Array<TaskBriefRow & { overdue: boolean }> = pendingRows.map((row) => {
		const dueMs = row.due_at ? Date.parse(row.due_at) : Number.NaN;
		const overdue = Number.isFinite(dueMs) && dueMs <= now.getTime();
		return {
			id: row.id,
			action: row.action,
			dueAt: row.due_at,
			customerKey: row.customer_key,
			customerName: row.customer_name,
			status: row.status,
			overdue,
		};
	});

	const customers = db.prepare("SELECT COUNT(*) AS n FROM customers WHERE tenant_id = ?").get(input.tenantId) as { n: number };

	const intentRows: Array<{ intent: string; count: number }> = [];
	const stats: DigestStats = {
		date,
		pendingTasks: pendingRows.length,
		overdueTasks: tasks.filter((t) => t.overdue).length,
		analyses24h: 0,
		vehiclePlans7d: 0,
		customers: customers.n,
		topIntents: [],
		priorityTasks: tasks.slice(0, 8).map((t) => ({
			customer: t.customerName ?? t.customerKey ?? "未知客户",
			action: t.action,
			dueAt: t.dueAt,
			overdue: t.overdue,
		})),
	};

	return { title: `助销晨报 · ${date}`, content: formatDigest(stats), stats };
}

export function formatDigest(stats: DigestStats): string {
	const lines: string[] = [];
	lines.push(`# 助销晨报 · ${stats.date}`);
	lines.push("");
	lines.push("## 关键数字");
	lines.push(`- 进行中跟进任务:${stats.pendingTasks}(其中已到期 ${stats.overdueTasks})`);
	lines.push(`- 客户总数:${stats.customers}`);
	lines.push("");
	lines.push("## 优先跟进(按到期时间)");
	if (stats.priorityTasks.length === 0) {
		lines.push("- 暂无待跟进任务,保持节奏。");
	} else {
		for (const task of stats.priorityTasks) {
			const flag = task.overdue ? "⚠️ 已到期" : task.dueAt ? `到期 ${task.dueAt}` : "无期限";
			lines.push(`- [${task.customer}] ${task.action}(${flag})`);
		}
	}
	lines.push("");
	lines.push("## 意图分布(近 7 天)");
	if (stats.topIntents.length === 0) {
		lines.push("- 暂无分析数据。");
	} else {
		for (const item of stats.topIntents) {
			lines.push(`- ${item.intent}: ${item.count} 次`);
		}
	}
	lines.push("");
	lines.push("## 今日建议");
	if (stats.overdueTasks > 0) {
		lines.push(`- 优先处理 ${stats.overdueTasks} 个已到期跟进,避免客户流失。`);
	} else if (stats.pendingTasks > 0) {
		lines.push("- 按到期顺序完成今日跟进,并在完成后及时标记。");
	} else {
		lines.push("- 暂无到期任务,可用于新客户触达与名单清洗。");
	}
	return lines.join("\n");
}

// ── 以下来自 v1 services/weekly-report.ts(功能逻辑与路由同文件) ──
export interface WeeklyReport {
	title: string;
	content: string;
	stats: {
		from: string;
		to: string;
				deals: number;
		dealAmount: number;
		taskRate: number;
		newCustomers: number;
		analyses: number;
		topIntents: Array<{ intent: string; count: number }>;
		topVehicles: Array<{ name: string; count: number }>;
		funnel: Array<{ stage: string; count: number }>;
	};
}

/** 周报:近 7 天经营汇总(分析/成交/任务/意图/车型/漏斗),供每周自动生成与手动触发。 */
export function collectWeeklyReport(db: DatabaseSync, tenantId: string, now = new Date()): WeeklyReport {
	const to = now.toISOString().slice(0, 10);
	const from = new Date(now.getTime() - 6 * DAY_MS).toISOString().slice(0, 10);


	const deal = db
		.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount FROM deals WHERE tenant_id = ? AND status = 'closed' AND dealed_at >= ?")
		.get(tenantId, `${from}T00:00:00Z`) as { n: number; amount: number };

	const task = db
		.prepare(
			"SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done FROM next_step_tasks WHERE tenant_id = ? AND created_at >= ?",
		)
		.get(tenantId, `${from}T00:00:00Z`) as { total: number; done: number };

	const newCustomers = (db.prepare("SELECT COUNT(*) AS n FROM customers WHERE tenant_id = ? AND created_at >= ?").get(tenantId, `${from}T00:00:00Z`) as { n: number }).n;


	const funnel = getFunnelStats(db, tenantId, undefined, now).stages.map((s) => ({ stage: s.stage, count: s.count }));

	const taskRate = task.total > 0 ? (task.done ?? 0) / task.total : 0;
	const intents: Array<{ intent: string; count: number }> = [];
	const stats: WeeklyReport["stats"] = { from, to, analyses: 0, deals: deal.n, dealAmount: deal.amount, taskRate, newCustomers, topIntents: [], topVehicles: [], funnel };

	const lines = [
		`本周(${from} ~ ${to})经营周报:`,
		`- 新增客户 ${newCustomers} 位`,
		`- 成交 ${deal.n} 单,成交额 ¥${deal.amount.toLocaleString()},任务完成率 ${Math.round(taskRate * 100)}%`,


		`- 漏斗:${funnel.map((f) => `${f.stage}:${f.count}`).join(" / ")}`,
	];
	return { title: `经营周报(${from} ~ ${to})`, content: lines.join("\n"), stats };
}

// ── 以下来自 v1 services/insights.ts(功能逻辑与路由同文件) ──
export interface Insights {
	days: number;
	analyses: number;
	analysesByDay: Array<{ date: string; count: number }>;
	topIntents: Array<{ intent: string; count: number }>;
	pendingTasks: number;
	overdueTasks: number;
	taskCompletionRate: number;
	vehiclePlans: number;
	topBrands: Array<{ brand: string; count: number }>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 经营洞察:近 N 天的分析量/意图分布/任务完成率/车型偏好。 */
export function collectInsights(db: DatabaseSync, input: { tenantId: string; days?: number; now?: Date }): Insights {
	const days = Math.min(Math.max(input.days ?? config.insightsDays, 1), 90);
	const now = input.now ?? new Date();
	const since = new Date(now.getTime() - days * DAY_MS);


	const pending = db.prepare("SELECT COUNT(*) AS n FROM next_step_tasks WHERE tenant_id = ? AND status = 'pending'").get(input.tenantId) as { n: number };
	const done = db.prepare("SELECT COUNT(*) AS n FROM next_step_tasks WHERE tenant_id = ? AND status = 'done'").get(input.tenantId) as { n: number };
	const overdueRows = db
		.prepare(
			`SELECT id, due_at FROM next_step_tasks WHERE tenant_id = ? AND status = 'pending' AND due_at IS NOT NULL`,
		)
		.all(input.tenantId) as Array<{ due_at: string }>;
	const overdue = overdueRows.filter((row) => Number.isFinite(Date.parse(row.due_at)) && Date.parse(row.due_at) <= now.getTime()).length;


	// 热门品牌原取自车型优选方案(vehicle_match_plans),该功能已删,这里恒为空
	const topBrands: Array<{ brand: string; count: number }> = [];

	const totalTasks = pending.n + done.n;
	return {
		days,
		analyses: 0,
		analysesByDay: [],
		topIntents: [],
		pendingTasks: pending.n,
		overdueTasks: overdue,
		taskCompletionRate: totalTasks === 0 ? 0 : Math.round((done.n / totalTasks) * 100) / 100,
		vehiclePlans: 0,
		topBrands,
	};
}

export function registerAssistantRoutes(app: FastifyInstance, deps: RouteDeps): void {
app.get<{ Querystring: { days?: string } }>("/api/v1/assistant/insights", async (request) => {
		const days = Number(request.query.days ?? config.insightsDays) || config.insightsDays;
		return collectInsights(deps.db, { tenantId: request.tenantId, days });
	});

app.post("/api/v1/assistant/digest", async (request, reply) => {
		const output = collectDigest(deps.db, { tenantId: request.tenantId });
		const existing = getDigestByDate(deps.db, request.tenantId, output.stats.date);
		if (existing) {
			return {
				digestId: existing.id,
				reused: true,
				title: existing.title,
				content: existing.content,
				stats: JSON.parse(existing.statsJson) as unknown,
				createdAt: existing.createdAt,
			};
		}
		const record = createDigest(deps.db, {
			tenantId: request.tenantId,
			digestDate: output.stats.date,
			title: output.title,
			content: output.content,
			statsJson: JSON.stringify(output.stats),
		});
		return { digestId: record.id, reused: false, title: output.title, content: output.content, stats: output.stats, createdAt: record.createdAt };
	});

app.get("/api/v1/assistant/digests", async (request, reply) => {
		const rows = listDigests(deps.db, request.tenantId);
		return {
			digests: rows.map((r) => ({
				id: r.id,
				digestDate: r.digestDate,
				title: r.title,
				content: r.content,
				stats: JSON.parse(r.statsJson) as unknown,
				createdAt: r.createdAt,
			})),
		};
	});
}
