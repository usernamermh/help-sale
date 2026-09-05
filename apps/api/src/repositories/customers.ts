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
	created_at: string;
	updated_at: string;
}

export function upsertCustomer(db: DatabaseSync, input: CustomerInput): CustomerRow {
	const existing = db
		.prepare("SELECT * FROM customers WHERE tenant_id = ? AND key = ?")
		.get(input.tenantId, input.key) as unknown as CustomerRow | undefined;

	if (existing) {
		db.prepare(
			`UPDATE customers
			 SET name = ?, company = ?, stage = ?, notes = ?, phone = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
			 WHERE id = ?`,
		).run(
			input.name ?? existing.name,
			input.company ?? existing.company,
			input.stage ?? existing.stage,
			input.notes ?? existing.notes,
			input.phone ?? existing.phone ?? null,
			existing.id,
		);
		return db.prepare("SELECT * FROM customers WHERE id = ?").get(existing.id) as unknown as CustomerRow;
	}

	const id = randomUUID();
	db.prepare("INSERT INTO customers (id, tenant_id, key, name, company, stage, notes, phone) VALUES (?,?,?,?,?,?,?,?)").run(
		id,
		input.tenantId,
		input.key,
		input.name ?? null,
		input.company ?? null,
		input.stage ?? null,
		input.notes ?? null,
		input.phone ?? null,
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