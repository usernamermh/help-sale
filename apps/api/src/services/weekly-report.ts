import type { DatabaseSync } from "node:sqlite";
import { getFunnelStats } from "../repositories/funnel.js";

export interface WeeklyReport {
	title: string;
	content: string;
	stats: {
		from: string;
		to: string;
		analyses: number;
		deals: number;
		dealAmount: number;
		taskRate: number;
		newCustomers: number;
		topIntents: Array<{ intent: string; count: number }>;
		topVehicles: Array<{ name: string; count: number }>;
		funnel: Array<{ stage: string; count: number }>;
	};
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 周报:近 7 天经营汇总(分析/成交/任务/意图/车型/漏斗),供每周自动生成与手动触发。 */
export function collectWeeklyReport(db: DatabaseSync, tenantId: string, now = new Date()): WeeklyReport {
	const to = now.toISOString().slice(0, 10);
	const from = new Date(now.getTime() - 6 * DAY_MS).toISOString().slice(0, 10);

	const analyses = (db.prepare("SELECT COUNT(*) AS n FROM analyses WHERE tenant_id = ? AND created_at >= ?").get(tenantId, `${from}T00:00:00Z`) as { n: number }).n;

	const deal = db
		.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount FROM deals WHERE tenant_id = ? AND status = 'closed' AND dealed_at >= ?")
		.get(tenantId, `${from}T00:00:00Z`) as { n: number; amount: number };

	const task = db
		.prepare(
			"SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done FROM next_step_tasks WHERE tenant_id = ? AND created_at >= ?",
		)
		.get(tenantId, `${from}T00:00:00Z`) as { total: number; done: number };

	const newCustomers = (db.prepare("SELECT COUNT(*) AS n FROM customers WHERE tenant_id = ? AND created_at >= ?").get(tenantId, `${from}T00:00:00Z`) as { n: number }).n;

	const intents = db
		.prepare(
			`SELECT intent, COUNT(*) AS count FROM analyses
			 WHERE tenant_id = ? AND created_at >= ? GROUP BY intent ORDER BY count DESC LIMIT 5`,
		)
		.all(tenantId, `${from}T00:00:00Z`) as Array<{ intent: string; count: number }>;

	const vehicles = db
		.prepare(
			`SELECT COALESCE(v.model_name, '未指定车型') AS name, COUNT(*) AS count FROM deals d
			 LEFT JOIN vehicles v ON v.id = d.vehicle_id
			 WHERE d.tenant_id = ? AND d.status = 'closed' AND d.dealed_at >= ?
			 GROUP BY name ORDER BY count DESC LIMIT 5`,
		)
		.all(tenantId, `${from}T00:00:00Z`) as Array<{ name: string; count: number }>;

	const funnel = getFunnelStats(db, tenantId, undefined, now).stages.map((s) => ({ stage: s.stage, count: s.count }));

	const taskRate = task.total > 0 ? (task.done ?? 0) / task.total : 0;
	const stats: WeeklyReport["stats"] = { from, to, analyses, deals: deal.n, dealAmount: deal.amount, taskRate, newCustomers, topIntents: intents, topVehicles: vehicles, funnel };

	const lines = [
		`本周(${from} ~ ${to})经营周报:`,
		`- 新增客户 ${newCustomers} 位 / 会话分析 ${analyses} 次`,
		`- 成交 ${deal.n} 单,成交额 ¥${deal.amount.toLocaleString()},任务完成率 ${Math.round(taskRate * 100)}%`,
		`- 热门意图:${intents.map((i) => `${i.intent}×${i.count}`).join("、") || "无"}`,
		`- 热销车型:${vehicles.map((v) => `${v.name}×${v.count}`).join("、") || "无"}`,
		`- 漏斗:${funnel.map((f) => `${f.stage}:${f.count}`).join(" / ")}`,
	];
	return { title: `经营周报(${from} ~ ${to})`, content: lines.join("\n"), stats };
}