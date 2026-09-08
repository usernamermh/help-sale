import type { DatabaseSync } from "node:sqlite";
import { getCustomer } from "../repositories/customers.js";

export interface TaskBriefRow {
	id: string;
	action: string;
	dueAt: string | null;
	customerKey: string | null;
	customerName: string | null;
	status: string;
}

export interface DigestStats {
	date: string;
	pendingTasks: number;
	overdueTasks: number;
	analyses24h: number;
	vehiclePlans7d: number;
	customers: number;
	topIntents: Array<{ intent: string; count: number }>;
	priorityTasks: Array<{
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

const DAY_MS = 24 * 60 * 60 * 1000;

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

	const analyses24h = db
		.prepare(`SELECT COUNT(*) AS n FROM analyses WHERE tenant_id = ? AND created_at >= ?`)
		.get(input.tenantId, new Date(now.getTime() - DAY_MS).toISOString()) as { n: number };
	const vehiclePlans7d = db
		.prepare(`SELECT COUNT(*) AS n FROM vehicle_match_plans WHERE tenant_id = ? AND created_at >= ?`)
		.get(input.tenantId, new Date(now.getTime() - 7 * DAY_MS).toISOString()) as { n: number };
	const customers = db.prepare("SELECT COUNT(*) AS n FROM customers WHERE tenant_id = ?").get(input.tenantId) as { n: number };

	const intentRows = db
		.prepare(
			`SELECT intent, COUNT(*) AS count FROM analyses
			 WHERE tenant_id = ? AND created_at >= ?
			 GROUP BY intent ORDER BY count DESC LIMIT 5`,
		)
		.all(input.tenantId, new Date(now.getTime() - 7 * DAY_MS).toISOString()) as Array<{ intent: string; count: number }>;

	const stats: DigestStats = {
		date,
		pendingTasks: pendingRows.length,
		overdueTasks: tasks.filter((t) => t.overdue).length,
		analyses24h: analyses24h.n,
		vehiclePlans7d: vehiclePlans7d.n,
		customers: customers.n,
		topIntents: intentRows.map((r) => ({ intent: r.intent, count: r.count })),
		priorityTasks: tasks.slice(0, 8).map((t) => ({
			customer: t.customerName ?? t.customerKey ?? "未知客户",
			action: t.action,
			dueAt: t.dueAt,
			overdue: t.overdue,
		})),
	};

	return { title: `销售军师晨报 · ${date}`, content: formatDigest(stats), stats };
}

export function formatDigest(stats: DigestStats): string {
	const lines: string[] = [];
	lines.push(`# 销售军师晨报 · ${stats.date}`);
	lines.push("");
	lines.push("## 关键数字");
	lines.push(`- 进行中跟进任务:${stats.pendingTasks}(其中已到期 ${stats.overdueTasks})`);
	lines.push(`- 最近 24 小时新增分析:${stats.analyses24h}`);
	lines.push(`- 近 7 天车型优选方案:${stats.vehiclePlans7d}`);
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