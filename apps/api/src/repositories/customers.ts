import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface CustomerInput {
	tenantId: string;
	key: string;
	name?: string;
	company?: string;
	stage?: string;
	notes?: string;
	phone?: string;
	/** 意向车型列表(如 ["汉EV 冠军版","Model Y 后驱版"]),落库为 JSON 数组 */
	intendedVehicles?: string[];
	/** 地区来源(如 "苏州"/"上海") */
	region?: string;
}

export interface CustomerRow {
	id: string;
	tenant_id: string;
	key: string;
	name: string | null;
	company: string | null;
	stage: string | null;
	notes: string | null;
	phone: string | null;
	intended_vehicles: string | null;
	region: string | null;
	created_at: string;
	updated_at: string;
}

export function upsertCustomer(db: DatabaseSync, input: CustomerInput): CustomerRow {
	const existing = db
		.prepare("SELECT * FROM customers WHERE tenant_id = ? AND key = ?")
		.get(input.tenantId, input.key) as unknown as CustomerRow | undefined;

	if (existing) {
		const nextVehicles = input.intendedVehicles !== undefined ? JSON.stringify(input.intendedVehicles) : existing.intended_vehicles;
		db.prepare(
			`UPDATE customers
			 SET name = ?, company = ?, stage = ?, notes = ?, phone = ?, intended_vehicles = ?, region = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
			 WHERE id = ?`,
		).run(
			input.name ?? existing.name,
			input.company ?? existing.company,
			input.stage ?? existing.stage,
			input.notes ?? existing.notes,
			input.phone ?? existing.phone ?? null,
			nextVehicles,
			input.region !== undefined ? input.region : existing.region ?? null,
			existing.id,
		);
		return db.prepare("SELECT * FROM customers WHERE id = ?").get(existing.id) as unknown as CustomerRow;
	}

	const id = randomUUID();
	db.prepare(
		"INSERT INTO customers (id, tenant_id, key, name, company, stage, notes, phone, intended_vehicles, region) VALUES (?,?,?,?,?,?,?,?,?,?)",
	).run(
		id,
		input.tenantId,
		input.key,
		input.name ?? null,
		input.company ?? null,
		input.stage ?? null,
		input.notes ?? null,
		input.phone ?? null,
		input.intendedVehicles !== undefined ? JSON.stringify(input.intendedVehicles) : null,
		input.region ?? null,
	);
	return db.prepare("SELECT * FROM customers WHERE id = ?").get(id) as unknown as CustomerRow;
}

export function getCustomer(db: DatabaseSync, tenantId: string, key: string): CustomerRow | undefined {
	return db.prepare("SELECT * FROM customers WHERE tenant_id = ? AND key = ?").get(tenantId, key) as unknown as CustomerRow | undefined;
}

export function requireTenant(db: DatabaseSync, tenantId: string, name = "未命名租户", slug?: string): void {
	const row = db.prepare("SELECT id FROM tenants WHERE id = ?").get(tenantId);
	if (!row) {
		db.prepare("INSERT INTO tenants (id, name, slug) VALUES (?,?,?)").run(tenantId, name, slug ?? `t-${tenantId.slice(0, 8)}`);
	}
}

export interface CustomerBriefRow {
	id: string;
	key: string;
	name: string | null;
	phone: string | null;
	stage: string | null;
	intendedVehicles: string[] | null;
	region: string | null;
	lastAnalysisAt: string | null;
	conversationCount: number;
}

/** 客户清单:key/姓名/电话/阶段/意向车型 + 最近分析时间与会话数,按最近分析倒序(供表格展示)。 */
export function listCustomers(db: DatabaseSync, tenantId: string, limit: number): CustomerBriefRow[] {
	const rows = db
		.prepare(
			`SELECT cu.id, cu.key, cu.name, cu.phone, cu.stage, cu.intended_vehicles, cu.region,
			        (SELECT MAX(a.created_at) FROM analyses a WHERE a.customer_id = cu.id) AS last_analysis_at,
			        (SELECT COUNT(*) FROM conversations c WHERE c.customer_id = cu.id) AS conversation_count
			 FROM customers cu
			 WHERE cu.tenant_id = ?
			 ORDER BY COALESCE((SELECT MAX(a.created_at) FROM analyses a WHERE a.customer_id = cu.id), '') DESC
			 LIMIT ?`,
		)
		.all(tenantId, limit) as unknown as Array<Record<string, unknown>>;
	return rows.map((r) => ({
		id: String(r.id),
		key: String(r.key),
		name: r.name != null ? String(r.name) : null,
		phone: r.phone != null ? String(r.phone) : null,
		stage: r.stage != null ? String(r.stage) : null,
		intendedVehicles: parseVehicles(r.intended_vehicles),
		region: r.region != null ? String(r.region) : null,
		lastAnalysisAt: r.last_analysis_at != null ? String(r.last_analysis_at) : null,
		conversationCount: Number(r.conversation_count ?? 0),
	}));
}

export function parseVehicles(raw: unknown): string[] | null {
	if (raw == null || raw === "") return null;
	try {
		const parsed = JSON.parse(String(raw)) as unknown;
		return Array.isArray(parsed) ? parsed.map(String) : null;
	} catch {
		return null;
	}
}