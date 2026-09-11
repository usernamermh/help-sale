import type { DatabaseSync } from "node:sqlite";

export interface SalesPerformanceRow {
	salesId: string;
	salesName: string;
	storeId: string | null;
	deals: number;
	dealAmount: number;
	avgDiscount: number | null;
	dealRate: number; // 成交客户数 / 负责客户数
	testDrives: number;
	testDriveConvert: number; // 试驾后成交率
	followupDone: number;
	followupTotal: number;
	followupRate: number;
	rank: number;
}

export interface WorkbenchTask {
	id: string;
	action: string;
	dueAt: string | null;
	status: string;
	customerKey: string | null;
	customerName: string | null;
	overdue: boolean;
}

export interface SalesWorkbench {
	salesId: string;
	salesName: string;
	storeId: string | null;
	todayTasks: WorkbenchTask[];
	overdueTasks: WorkbenchTask[];
	activeCustomers: Array<{ id: string; key: string; name: string | null; funnelStage: string | null; lastContact: string | null }>;
	monthDeals: number;
	monthAmount: number;
}

/** 门店销售绩效:成交量/额/率、试驾转化、回访完成率、折扣率,按门店排名。 */
export function getStorePerformance(db: DatabaseSync, tenantId: string, storeId?: string, from?: string, to?: string): SalesPerformanceRow[] {
	const clauses: string[] = [];
	const params: Array<string | number> = [];
	if (storeId) {
		clauses.push("s.store_id = ?");
		params.push(storeId);
	}
	if (from) {
		clauses.push("s.created_at >= ?");
		params.push(from);
	}
	params.push(tenantId);
	const sales = db
		.prepare(`SELECT s.id, s.name, s.store_id FROM sales s WHERE ${clauses.length ? clauses.join(" AND ") + " AND " : ""}s.tenant_id = ? ORDER BY s.name`)
		.all(...params) as Array<{ id: string; name: string; store_id: string | null }>;

	const dealRows = db
		.prepare(
			`SELECT sales_id, COUNT(*) AS n, SUM(amount) AS amount, AVG(discount_amount) AS avg_discount,
			        SUM(CASE WHEN discount_amount > 0 THEN 1 ELSE 0 END) AS discount_count
			 FROM deals WHERE tenant_id = ? AND status = 'closed'${storeId ? " AND store_id = ?" : ""}
			 GROUP BY sales_id`,
		)
		.all(tenantId, ...(storeId ? ([storeId] as Array<string | number>) : [])) as Array<{ sales_id: string | null; n: number; amount: number | null; avg_discount: number | null; discount_count: number }>;

	const tdRows = db
		.prepare(
			`SELECT sales_id, COUNT(*) AS n FROM test_drives WHERE tenant_id = ? AND status = 'completed'${storeId ? " AND store_id = ?" : ""} GROUP BY sales_id`,
		)
		.all(tenantId, ...(storeId ? ([storeId] as Array<string | number>) : [])) as Array<{ sales_id: string | null; n: number }>;

	const taskRows = db
		.prepare(
			`SELECT t.sales_id, COUNT(*) AS total, SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS done
			 FROM next_step_tasks t WHERE t.tenant_id = ? GROUP BY t.sales_id`,
		)
		.all(tenantId) as Array<{ sales_id: string | null; total: number; done: number }>;

	const rows: SalesPerformanceRow[] = [];
	for (const s of sales) {
		const deal = dealRows.find((d) => d.sales_id === s.id);
		const td = tdRows.find((d) => d.sales_id === s.id);
		const task = taskRows.find((d) => d.sales_id === s.id);
		rows.push({
			salesId: s.id,
			salesName: s.name,
			storeId: s.store_id,
			deals: deal?.n ?? 0,
			dealAmount: deal?.amount ?? 0,
			avgDiscount: deal && deal.discount_count ? (deal.avg_discount ?? 0) / deal.discount_count : null,
			dealRate: td && td.n > 0 ? (deal?.n ?? 0) / td.n : 0,
			testDrives: td?.n ?? 0,
			testDriveConvert: td && td.n > 0 ? (deal?.n ?? 0) / td.n : 0,
			followupDone: task?.done ?? 0,
			followupTotal: task?.total ?? 0,
			followupRate: task && task.total > 0 ? (task.done ?? 0) / task.total : 0,
			rank: 0,
		});
	}
	// 按成交量排序排名
	rows.sort((a, b) => b.deals - a.deals || b.dealAmount - a.dealAmount);
	rows.forEach((r, i) => (r.rank = i + 1));
	return rows;
}

/** 销售个人工作台:今日/逾期待办、跟进中客户、本月成交。 */
export function getSalesWorkbench(db: DatabaseSync, tenantId: string, salesId: string): SalesWorkbench | undefined {
	const sales = db.prepare("SELECT id, name, store_id FROM sales WHERE tenant_id = ? AND id = ?").get(tenantId, salesId) as
		| { id: string; name: string; store_id: string | null }
		| undefined;
	if (!sales) return undefined;
	const today = new Date().toISOString().slice(0, 10);

	const tasks = db
		.prepare(
			`SELECT t.id, t.action, t.due_at, t.status, c.key AS customer_key, c.name AS customer_name
			 FROM next_step_tasks t LEFT JOIN customers c ON c.id = t.customer_id
			 WHERE t.tenant_id = ? AND t.sales_id = ? AND t.status = 'pending' AND (t.due_at IS NULL OR t.due_at <= date('now', '+1 day'))
			 ORDER BY (t.due_at IS NULL), t.due_at ASC`,
		)
		.all(tenantId, salesId) as Array<{ id: string; action: string; due_at: string | null; status: string; customer_key: string | null; customer_name: string | null }>;

	const nowMs = Date.now();
	const mapped: WorkbenchTask[] = tasks.map((t) => ({
		id: t.id,
		action: t.action,
		dueAt: t.due_at,
		status: t.status,
		customerKey: t.customer_key,
		customerName: t.customer_name,
		overdue: t.due_at != null && Date.parse(t.due_at) <= nowMs,
	}));

	const activeCustomers = db
		.prepare(
			`SELECT c.id, c.key, c.name, c.funnel_stage, c.updated_at
			 FROM customers c
			 JOIN conversations cv ON cv.customer_id = c.id AND cv.tenant_id = c.tenant_id
			 WHERE c.tenant_id = ? AND cv.sales_id = ? AND COALESCE(c.funnel_stage, 'new') NOT IN ('closed_won', 'closed_lost')
			 GROUP BY c.id ORDER BY c.updated_at DESC LIMIT 50`,
		)
		.all(tenantId, salesId) as Array<{ id: string; key: string; name: string | null; funnel_stage: string | null; updated_at: string }>;

	const monthDeal = db
		.prepare(
			`SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount FROM deals
			 WHERE tenant_id = ? AND sales_id = ? AND status = 'closed' AND dealed_at >= date('now', 'start of month')`,
		)
		.get(tenantId, salesId) as { n: number; amount: number };

	return {
		salesId: sales.id,
		salesName: sales.name,
		storeId: sales.store_id,
		todayTasks: mapped.filter((t) => t.dueAt == null || t.dueAt.slice(0, 10) <= today),
		overdueTasks: mapped.filter((t) => t.overdue),
		activeCustomers: activeCustomers.map((c) => ({
			id: c.id,
			key: c.key,
			name: c.name,
			funnelStage: c.funnel_stage,
			lastContact: c.updated_at,
		})),
		monthDeals: monthDeal.n,
		monthAmount: monthDeal.amount,
	};
}