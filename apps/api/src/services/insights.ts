import type { DatabaseSync } from "node:sqlite";
import { config } from "../env.js";

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

	const analyses = db.prepare("SELECT COUNT(*) AS n FROM analyses WHERE tenant_id = ? AND created_at >= ?").get(input.tenantId, since.toISOString()) as { n: number };
	const byDayRows = db
		.prepare(
			`SELECT substr(created_at, 1, 10) AS date, COUNT(*) AS count
			 FROM analyses WHERE tenant_id = ? AND created_at >= ?
			 GROUP BY date ORDER BY date ASC`,
		)
		.all(input.tenantId, since.toISOString()) as Array<{ date: string; count: number }>;
	const intentRows = db
		.prepare(
			`SELECT intent, COUNT(*) AS count FROM analyses
			 WHERE tenant_id = ? AND created_at >= ?
			 GROUP BY intent ORDER BY count DESC LIMIT 6`,
		)
		.all(input.tenantId, since.toISOString()) as Array<{ intent: string; count: number }>;

	const pending = db.prepare("SELECT COUNT(*) AS n FROM next_step_tasks WHERE tenant_id = ? AND status = 'pending'").get(input.tenantId) as { n: number };
	const done = db.prepare("SELECT COUNT(*) AS n FROM next_step_tasks WHERE tenant_id = ? AND status = 'done'").get(input.tenantId) as { n: number };
	const overdueRows = db
		.prepare(
			`SELECT id, due_at FROM next_step_tasks WHERE tenant_id = ? AND status = 'pending' AND due_at IS NOT NULL`,
		)
		.all(input.tenantId) as Array<{ due_at: string }>;
	const overdue = overdueRows.filter((row) => Number.isFinite(Date.parse(row.due_at)) && Date.parse(row.due_at) <= now.getTime()).length;

	const vehiclePlans = db.prepare("SELECT COUNT(*) AS n FROM vehicle_match_plans WHERE tenant_id = ? AND created_at >= ?").get(input.tenantId, since.toISOString()) as { n: number };

	// 解析近期方案中的推荐品牌
	const planRows = db
		.prepare("SELECT plan_json FROM vehicle_match_plans WHERE tenant_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 50")
		.all(input.tenantId, since.toISOString()) as Array<{ plan_json: string }>;
	const brandCount = new Map<string, number>();
	for (const row of planRows) {
		try {
			const plan = JSON.parse(row.plan_json) as { recommendations?: Array<{ brand?: string }> };
			for (const rec of plan.recommendations ?? []) {
				if (rec.brand) brandCount.set(rec.brand, (brandCount.get(rec.brand) ?? 0) + 1);
			}
		} catch {
			// 忽略解析失败行
		}
	}
	const topBrands = [...brandCount.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 3)
		.map(([brand, count]) => ({ brand, count }));

	const totalTasks = pending.n + done.n;
	return {
		days,
		analyses: analyses.n,
		analysesByDay: byDayRows,
		topIntents: intentRows,
		pendingTasks: pending.n,
		overdueTasks: overdue,
		taskCompletionRate: totalTasks === 0 ? 0 : Math.round((done.n / totalTasks) * 100) / 100,
		vehiclePlans: vehiclePlans.n,
		topBrands,
	};
}