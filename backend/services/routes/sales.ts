import type { DatabaseSync } from "node:sqlite";
import { config } from "../../env.js";
import { createTask } from "../../integrations_pi/tables/sales/tasks.js";
import { listStores, getStore, upsertStore, getStoreManager, getStoreOverview, upsertSalesperson, getSalespersonById, listSales, listDeals, upsertSalesperson as upsertSalespersonStore, createDeal } from "../../integrations_pi/tables/sales/stores.js";
import { resolveManagerScope, type RouteDeps } from "./helpers.js";
import { setFunnelStage, getFunnelStats, listSilentCustomers } from "../../integrations_pi/tables/crm/funnel.js";
import { upsertCustomer } from "../../integrations_pi/tables/crm/customers.js";
import type { FastifyInstance } from "fastify";

// ── 以下来自 v1 services/performance.ts(功能逻辑与路由同文件) ──
export interface SalesPerformanceRow {
	salesId: string;
	salesName: string;
	storeId: string | null;
	deals: number;
	dealAmount: number;
	avgDiscount: number | null;
	/** 试驾相关指标:试驾功能(含 test_drives 表)已删除,这里恒为 0,保留字段仅为兼容前端 */
	dealRate: number;
	testDrives: number;
	testDriveConvert: number;
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

	const taskRows = db
		.prepare(
			`SELECT t.sales_id, COUNT(*) AS total, SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS done
			 FROM next_step_tasks t WHERE t.tenant_id = ? GROUP BY t.sales_id`,
		)
		.all(tenantId) as Array<{ sales_id: string | null; total: number; done: number }>;

	const rows: SalesPerformanceRow[] = [];
	for (const s of sales) {
		const deal = dealRows.find((d) => d.sales_id === s.id);
		const task = taskRows.find((d) => d.sales_id === s.id);
		rows.push({
			salesId: s.id,
			salesName: s.name,
			storeId: s.store_id,
			deals: deal?.n ?? 0,
			dealAmount: deal?.amount ?? 0,
			avgDiscount: deal && deal.discount_count ? (deal.avg_discount ?? 0) / deal.discount_count : null,
			// 试驾功能已删除(表 test_drives 一并移除),相关指标保留字段但恒为 0
			dealRate: 0,
			testDrives: 0,
			testDriveConvert: 0,
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

// ── 以下来自 v1 services/followup-rhythm.ts(功能逻辑与路由同文件) ──
const HOUR_MS = 60 * 60 * 1000;

/**
 * 回访节奏:试驾后 24 小时/3 天/7 天自动生成回访任务,提车(成交)后关怀回访。
 * 把"什么时候该联系谁"从销售人脑里解放出来。
 */

/** 试驾完成后生成三段式回访节奏(24h/3d/7d),返回创建的任务 action 列表。 */
export function scheduleTestDriveFollowups(
	db: DatabaseSync,
	tenantId: string,
	customerId: string,
	baseAt: string,
): string[] {
	const base = new Date(baseAt);
	const rhythms: Array<{ label: string; offsetMs: number }> = [
		{ label: "试驾后回访(24小时):确认试驾感受与疑虑", offsetMs: 24 * HOUR_MS },
		{ label: "试驾后回访(3天):推进报价/方案,询问竞品对比", offsetMs: 3 * 24 * HOUR_MS },
		{ label: "试驾后回访(7天):促成到店/成交,或转入长线培育", offsetMs: 7 * 24 * HOUR_MS },
	];
	const actions: string[] = [];
	for (const r of rhythms) {
		const due = new Date(base.getTime() + r.offsetMs).toISOString();
		createTask(db, { tenantId, customerId, action: r.label, dueAt: due });
		actions.push(r.label);
	}
	return actions;
}

/** 提车关怀:成交后第 3 天回访用车体验,第 30 天提醒保养/转介绍。 */
export function scheduleDeliveryFollowups(db: DatabaseSync, tenantId: string, customerId: string, dealedAt: string): string[] {
	const base = new Date(dealedAt);
	const rhythms: Array<{ label: string; offsetMs: number }> = [
		{ label: "提车关怀(3天):确认用车体验,收集满意度", offsetMs: 3 * 24 * HOUR_MS },
		{ label: "保养提醒(30天):首保/保养邀约,老带新转介绍", offsetMs: 30 * 24 * HOUR_MS },
	];
	const actions: string[] = [];
	for (const r of rhythms) {
		const due = new Date(base.getTime() + r.offsetMs).toISOString();
		createTask(db, { tenantId, customerId, action: r.label, dueAt: due });
		actions.push(r.label);
	}
	return actions;
}

// sales 域路由(由 v1 routes/list_for_view.ts 拆分而来)

export function registerSalesRoutes(app: FastifyInstance, deps: RouteDeps): void {
app.get("/api/v1/stores", async (request) => {
		return { stores: listStores(deps.db, request.tenantId) };
	});

app.post<{ Body: { name?: string; address?: string; managerName?: string; managerPhone?: string } }>("/api/v1/stores", async (request, reply) => {
		const name = request.body?.name?.trim();
		if (!name) return reply.code(400).send({ error: "store name is required" });
		const store = upsertStore(deps.db, request.tenantId, { name, address: request.body?.address });
		if (request.body?.managerName?.trim()) {
			upsertSalesperson(deps.db, request.tenantId, { storeId: store.id, name: request.body.managerName.trim(), phone: request.body.managerPhone, role: "manager" });
		}
		return { store };
	});

app.get<{ Params: { id: string } }>("/api/v1/stores/:id", async (request, reply) => {
		const store = getStore(deps.db, request.tenantId, request.params.id);
		if (!store) return reply.code(404).send({ error: "store_not_found", message: "门店不存在" });
		const { manager, sales } = getStoreManager(deps.db, request.tenantId, store.id);
		return { store, manager, sales };
	});

app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>("/api/v1/stores/:id/overview", async (request, reply) => {
		const store = getStore(deps.db, request.tenantId, request.params.id);
		if (!store) return reply.code(404).send({ error: "store_not_found", message: "门店不存在" });
		const scope = await resolveManagerScope(deps.db, request.tenantId, request.headers, store.id);
		if (scope.denied || (scope.storeId && scope.storeId !== store.id)) {
			return reply.code(403).send({ error: "forbidden", message: "店长只能查看所属门店数据" });
		}
		return getStoreOverview(deps.db, request.tenantId, { storeId: store.id, from: request.query.from, to: request.query.to });
	});

app.post<{ Params: { key: string }; Body: { stage?: string; lostReason?: string } }>("/api/v1/customers/:key/funnel", async (request, reply) => {
		const stage = String(request.body?.stage ?? "").trim();
		if (!stage) return reply.code(400).send({ error: "stage is required" });
		try {
			const row = setFunnelStage(deps.db, request.tenantId, request.params.key, stage, request.body?.lostReason);
			if (!row) return reply.code(404).send({ error: "customer_not_found", message: "客户不存在" });
			return row;
		} catch (error) {
			return reply.code(400).send({ error: "invalid_stage", message: error instanceof Error ? error.message : String(error) });
		}
	});

app.get<{ Params: { id: string } }>("/api/v1/stores/:id/funnel", async (request, reply) => {
		const scope = await resolveManagerScope(deps.db, request.tenantId, request.headers, request.params.id);
		if (scope.denied) return reply.code(403).send({ error: "forbidden", message: "店长仅可查看所属门店" });
		return { storeId: request.params.id, stats: getFunnelStats(deps.db, request.tenantId, request.params.id) };
	});

app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>("/api/v1/stores/:id/performance", async (request, reply) => {
		const scope = await resolveManagerScope(deps.db, request.tenantId, request.headers, request.params.id);
		if (scope.denied) return reply.code(403).send({ error: "forbidden", message: "店长仅可查看所属门店" });
		return { storeId: request.params.id, performance: getStorePerformance(deps.db, request.tenantId, request.params.id, request.query.from, request.query.to) };
	});

app.get<{ Params: { id: string } }>("/api/v1/sales/:id/workbench", async (request) => {
		const wb = getSalesWorkbench(deps.db, request.tenantId, request.params.id);
		return wb ?? { error: "sales_not_found", message: "销售不存在" };
	});

app.get<{ Params: { id: string }; Querystring: { days?: string } }>("/api/v1/stores/:id/silent-customers", async (request, reply) => {
		const scope = await resolveManagerScope(deps.db, request.tenantId, request.headers, request.params.id);
		if (scope.denied) return reply.code(403).send({ error: "forbidden", message: "店长仅可查看所属门店" });
		const days = Number.parseInt(request.query.days ?? "7", 10);
		return { storeId: request.params.id, customers: listSilentCustomers(deps.db, request.tenantId, Number.isFinite(days) ? days : 7, request.params.id) };
	});

app.get<{ Querystring: { storeId?: string } }>("/api/v1/sales", async (request) => {
		return { sales: listSales(deps.db, request.tenantId, request.query.storeId) };
	});

app.post<{ Body: { storeId?: string; name?: string; phone?: string; role?: string } }>("/api/v1/sales", async (request, reply) => {
		const name = request.body?.name?.trim();
		if (!name) return reply.code(400).send({ error: "sales name is required" });
		const salesperson = upsertSalespersonStore(deps.db, request.tenantId, { storeId: request.body?.storeId, name, phone: request.body?.phone, role: request.body?.role });
		return { salesperson };
	});

app.get<{ Querystring: { storeId?: string; from?: string; to?: string; limit?: string } }>("/api/v1/deals", async (request, reply) => {
		const scope = await resolveManagerScope(deps.db, request.tenantId, request.headers, request.query.storeId);
		if (scope.denied) return reply.code(403).send({ error: "forbidden", message: "店长只能查看所属门店数据" });
		const limit = Number(request.query.limit ?? config.dealsLimit) || config.dealsLimit;
		return { deals: listDeals(deps.db, request.tenantId, { storeId: scope.storeId, from: request.query.from, to: request.query.to, limit }) };
	});

app.post<{ Body: { customerKey?: string; salesId?: string; storeId?: string; amount?: number; dealedAt?: string; status?: string } }>("/api/v1/deals", async (request, reply) => {
		const body = request.body ?? {};
		const amount = Number(body.amount);
		if (!body.customerKey?.trim() || !Number.isFinite(amount) || amount <= 0) {
			return reply.code(400).send({ error: "customerKey and amount are required" });
		}
		const customer = upsertCustomer(deps.db, { tenantId: request.tenantId, key: body.customerKey.trim() });
		const salesRow = body.salesId ? getSalespersonById(deps.db, request.tenantId, body.salesId) : undefined;
		if (body.salesId && !salesRow) return reply.code(400).send({ error: "sales_not_found", message: "销售不存在" });
		const storeId = body.storeId ?? salesRow?.store_id ?? null;
		if (!body.salesId && !storeId) return reply.code(400).send({ error: "storeId or salesId is required" });
		const deal = createDeal(deps.db, request.tenantId, {
			storeId: storeId ?? undefined,
			salesId: salesRow?.id ?? body.salesId ?? undefined,
			customerId: customer.id,
			amount,
			dealedAt: body.dealedAt,
			status: body.status,
		});
		let followups: string[] = [];
		if (deal.status === "closed") {
			const base = deal.dealed_at ?? deal.created_at;
			followups = scheduleDeliveryFollowups(deps.db, request.tenantId, customer.id, base);
		}
		return { deal, followups };
	});
	// ── 会话 ──
}
