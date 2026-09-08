import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { config } from "../env.js";

export interface StoreRow {
	id: string; tenant_id: string; name: string; address: string | null; created_at: string;
}
export interface SalesRow {
	id: string; tenant_id: string; store_id: string | null; name: string; phone: string | null; role: string; created_at: string;
}
export interface DealRow {
	id: string; tenant_id: string; store_id: string | null; sales_id: string | null; customer_id: string | null;
	conversation_id: string | null; amount: number; status: string; dealed_at: string; created_at: string;
}

export function createStore(db: DatabaseSync, tenantId: string, input: { name: string; address?: string }): StoreRow {
	const id = randomUUID();
	db.prepare("INSERT INTO stores (id, tenant_id, name, address) VALUES (?,?,?,?)").run(id, tenantId, input.name, input.address ?? null);
	return db.prepare("SELECT * FROM stores WHERE id = ?").get(id) as unknown as StoreRow;
}

/** 按(租户, 名称)幂等创建/更新门店,用于种子与 API。 */
export function upsertStore(db: DatabaseSync, tenantId: string, input: { name: string; address?: string }): StoreRow {
	const existing = db.prepare("SELECT * FROM stores WHERE tenant_id = ? AND name = ?").get(tenantId, input.name) as unknown as StoreRow | undefined;
	if (existing) {
		if (input.address !== undefined) {
			db.prepare("UPDATE stores SET address = ? WHERE id = ?").run(input.address ?? null, existing.id);
			return db.prepare("SELECT * FROM stores WHERE id = ?").get(existing.id) as unknown as StoreRow;
		}
		return existing;
	}
	return createStore(db, tenantId, input);
}

export function getStore(db: DatabaseSync, tenantId: string, storeId: string): StoreRow | undefined {
	return db.prepare("SELECT * FROM stores WHERE tenant_id = ? AND id = ?").get(tenantId, storeId) as unknown as StoreRow | undefined;
}

export function listStores(db: DatabaseSync, tenantId: string): StoreRow[] {
	return db.prepare("SELECT * FROM stores WHERE tenant_id = ? ORDER BY name").all(tenantId) as unknown as StoreRow[];
}
export function listSales(db: DatabaseSync, tenantId: string, storeId?: string): SalesRow[] {
	return storeId
		? db.prepare("SELECT * FROM sales WHERE tenant_id = ? AND store_id = ? ORDER BY role DESC, name").all(tenantId, storeId) as unknown as SalesRow[]
		: db.prepare("SELECT * FROM sales WHERE tenant_id = ? ORDER BY store_id, role DESC, name").all(tenantId) as unknown as SalesRow[];
}

export interface SalespersonInput {
	storeId?: string | null;
	name: string;
	phone?: string | null;
	role?: string;
}

/** 按(租户, 门店, 姓名)幂等创建/更新销售或店长。 */
export function upsertSalesperson(db: DatabaseSync, tenantId: string, input: SalespersonInput): SalesRow {
	const existing = input.storeId
		? db.prepare("SELECT * FROM sales WHERE tenant_id = ? AND name = ? AND store_id = ?").get(tenantId, input.name, input.storeId) as unknown as SalesRow | undefined
		: db.prepare("SELECT * FROM sales WHERE tenant_id = ? AND name = ? AND store_id IS NULL").get(tenantId, input.name) as unknown as SalesRow | undefined;
	if (existing) {
		db.prepare("UPDATE sales SET store_id = ?, phone = ?, role = ? WHERE id = ?").run(
			input.storeId ?? null,
			input.phone ?? existing.phone ?? null,
			input.role ?? existing.role,
			existing.id,
		);
		return db.prepare("SELECT * FROM sales WHERE id = ?").get(existing.id) as unknown as SalesRow;
	}
	const id = randomUUID();
	db.prepare("INSERT INTO sales (id, tenant_id, store_id, name, phone, role) VALUES (?,?,?,?,?,?)").run(
		id,
		tenantId,
		input.storeId ?? null,
		input.name,
		input.phone ?? null,
		input.role ?? "sales",
	);
	return db.prepare("SELECT * FROM sales WHERE id = ?").get(id) as unknown as SalesRow;
}

export function getSalespersonById(db: DatabaseSync, tenantId: string, id: string): SalesRow | undefined {
	return db.prepare("SELECT * FROM sales WHERE tenant_id = ? AND id = ?").get(tenantId, id) as unknown as SalesRow | undefined;
}

export function getStoreManager(db: DatabaseSync, tenantId: string, storeId: string): { manager: SalesRow | null; sales: SalesRow[] } {
	const sales = listSales(db, tenantId, storeId);
	return { manager: sales.find((s) => s.role === "manager") ?? null, sales };
}

export interface CreateDealInput {
	storeId?: string | null;
	salesId?: string | null;
	customerId?: string | null;
	conversationId?: string | null;
	amount: number;
	status?: string;
	dealedAt?: string;
	/** 指定 id 时幂等(重复插入返回已有行,用于种子)。 */
	id?: string;
}

export function createDeal(db: DatabaseSync, tenantId: string, input: CreateDealInput): DealRow {
	const id = input.id ?? randomUUID();
	const dealedAt = input.dealedAt ?? new Date().toISOString();
	db.prepare(
		`INSERT OR IGNORE INTO deals (id, tenant_id, store_id, sales_id, customer_id, conversation_id, amount, status, dealed_at)
		 VALUES (?,?,?,?,?,?,?,?,?)`,
	).run(id, tenantId, input.storeId ?? null, input.salesId ?? null, input.customerId ?? null, input.conversationId ?? null, input.amount, input.status ?? "closed", dealedAt);
	return db.prepare("SELECT * FROM deals WHERE id = ?").get(id) as unknown as DealRow;
}

export type DealWithParties = DealRow & {
	customerName: string | null;
	customerKey: string | null;
	customerPhone: string | null;
	salesName: string | null;
	salesPhone: string | null;
	storeName: string | null;
};

export interface DealListQuery {
	storeId?: string;
	salesId?: string;
	from?: string;
	to?: string;
	limit?: number;
}

export function listDeals(db: DatabaseSync, tenantId: string, query: DealListQuery = {}): DealWithParties[] {
	const where = ["d.tenant_id = ?"];
	const params: Array<string | number | null> = [tenantId];
	if (query.storeId) {
		where.push("d.store_id = ?");
		params.push(query.storeId);
	}
	if (query.salesId) {
		where.push("d.sales_id = ?");
		params.push(query.salesId);
	}
	if (query.from) {
		where.push("d.dealed_at >= ?");
		params.push(query.from);
	}
	if (query.to) {
		where.push("d.dealed_at <= ?");
		params.push(query.to);
	}
	const limit = Math.min(query.limit ?? 100, 200);
	return db.prepare(
		`SELECT d.*, cu.name AS customerName, cu.key AS customerKey, cu.phone AS customerPhone,
		        s.name AS salesName, s.phone AS salesPhone, st.name AS storeName
		 FROM deals d
		 LEFT JOIN customers cu ON cu.id = d.customer_id
		 LEFT JOIN sales s ON s.id = d.sales_id
		 LEFT JOIN stores st ON st.id = d.store_id
		 WHERE ${where.join(" AND ")}
		 ORDER BY d.dealed_at DESC
		 LIMIT ${limit}`,
	).all(...params) as unknown as DealWithParties[];
}

export interface StoreOverviewQuery { storeId?: string; from?: string; to?: string; }
export interface StoreOverview {
	store: StoreRow | null;
	from: string; to: string;
	visits: number;
	deals: number;
	amount: number;
	conversionRate: number;
	orders: Array<DealRow & { customerName: string | null; salesName: string | null }>;
	daily: Array<{ date: string; visits: number; deals: number; amount: number }>;
}

export function getStoreOverview(db: DatabaseSync, tenantId: string, query: StoreOverviewQuery): StoreOverview {
	const to = query.to ?? new Date().toISOString();
	const from = query.from ?? new Date(Date.now() - config.storeOverviewDays * 24 * 3600 * 1000).toISOString();
	// 默认取第一个门店(用于无 storeId 时的整体口径)
	const stores = listStores(db, tenantId);
	const store = query.storeId ? (db.prepare("SELECT * FROM stores WHERE tenant_id = ? AND id = ?").get(tenantId, query.storeId) as unknown as StoreRow | undefined) ?? null : (stores[0] ?? null);

	const convWhere = store ? ["tenant_id = ?", "store_id = ?", "created_at >= ?", "created_at <= ?"] : ["tenant_id = ?", "created_at >= ?", "created_at <= ?"];
	const convParams = store ? [tenantId, store.id, from, to] : [tenantId, from, to];
	const visits = (db.prepare(`SELECT COUNT(*) c FROM conversations WHERE ${convWhere.join(" AND ")}`).get(...convParams) as { c: number }).c;

	const dealWhere = store ? ["tenant_id = ?", "store_id = ?", "dealed_at >= ?", "dealed_at <= ?"] : ["tenant_id = ?", "dealed_at >= ?", "dealed_at <= ?"];
	const dealParams = store ? [tenantId, store.id, from, to] : [tenantId, from, to];
	const deals = (db.prepare(`SELECT COUNT(*) c FROM deals WHERE ${dealWhere.join(" AND ")}`).get(...dealParams) as { c: number }).c;
	const amount = (db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM deals WHERE ${dealWhere.join(" AND ")}`).get(...dealParams) as { s: number }).s;

	const ordersWhere = dealWhere.map((x) => x.replace(/^(tenant_id|store_id|dealed_at)(\s|=)/, "d.$1$2"));
	const orders = db.prepare(
		`SELECT d.*, c.name AS customerName, s.name AS salesName
		 FROM deals d
		 LEFT JOIN customers c ON c.id = d.customer_id
		 LEFT JOIN sales s ON s.id = d.sales_id
		 WHERE ${ordersWhere.join(" AND ")}
		 ORDER BY d.dealed_at DESC`
	).all(...dealParams) as unknown as Array<DealRow & { customerName: string | null; salesName: string | null }>;

	const daily = db.prepare(
		`SELECT substr(d.dealed_at,1,10) AS date, COUNT(d.id) AS deals, COALESCE(SUM(d.amount),0) AS amount
		 FROM deals d WHERE ${dealWhere.join(" AND ")} GROUP BY substr(d.dealed_at,1,10) ORDER BY date`
	).all(...dealParams) as unknown as Array<{ date: string; deals: number; amount: number }>;
	const visitDaily = db.prepare(
		`SELECT substr(c.created_at,1,10) AS date, COUNT(c.id) AS visits
		 FROM conversations c WHERE ${convWhere.join(" AND ")} GROUP BY substr(c.created_at,1,10)`
	).all(...convParams) as unknown as Array<{ date: string; visits: number }>;
	const dayMap = new Map<string, { date: string; visits: number; deals: number; amount: number }>();
	for (const r of daily) dayMap.set(r.date, { date: r.date, visits: 0, deals: r.deals, amount: r.amount });
	for (const r of visitDaily) {
		const d = dayMap.get(r.date) ?? { date: r.date, visits: 0, deals: 0, amount: 0 };
		d.visits = r.visits;
		dayMap.set(r.date, d);
	}

	return {
		store,
		from,
		to,
		visits,
		deals,
		amount,
		conversionRate: visits > 0 ? Number(((deals / visits) * 100).toFixed(1)) : 0,
		orders,
		daily: [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
	};
}