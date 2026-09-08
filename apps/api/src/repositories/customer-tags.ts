import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface CustomerTagRecord {
	id: string;
	tenantId: string;
	customerId: string;
	tag: string;
	kind: string;
	source: string | null;
	weight: number;
	createdAt: string;
	updatedAt: string | null;
}

export interface CustomerTagInput {
	tenantId: string;
	customerId: string;
	tag: string;
	kind?: string;
	source?: string;
}

/** 断言递增地累加标签权重(同租户/客户/标签/来源唯一)。 */
export function upsertCustomerTag(db: DatabaseSync, input: CustomerTagInput): void {
	const { tenantId, customerId, tag } = input;
	const existing = db
		.prepare("SELECT id FROM customer_tags WHERE tenant_id = ? AND customer_id = ? AND tag = ?")
		.get(tenantId, customerId, tag) as { id: string } | undefined;
	if (existing) {
		db.prepare(
			`UPDATE customer_tags
			 SET weight = weight + 1, source = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
			 WHERE id = ?`,
		).run(input.source ?? null, existing.id);
		return;
	}
	db.prepare(
		"INSERT INTO customer_tags (id, tenant_id, customer_id, tag, kind, source) VALUES (?,?,?,?,?,?)",
	).run(randomUUID(), tenantId, customerId, tag, input.kind ?? "auto", input.source ?? null);
}

export function listCustomerTags(db: DatabaseSync, tenantId: string, customerId: string, limit = 20): CustomerTagRecord[] {
	const rows = db
		.prepare(
			"SELECT * FROM customer_tags WHERE tenant_id = ? AND customer_id = ? ORDER BY weight DESC, created_at ASC LIMIT ?",
		)
		.all(tenantId, customerId, limit) as Record<string, unknown>[];
	return rows.map((row) => ({
		id: String(row.id),
		tenantId: String(row.tenant_id),
		customerId: String(row.customer_id),
		tag: String(row.tag),
		kind: String(row.kind),
		source: row.source ? String(row.source) : null,
		weight: Number(row.weight),
		createdAt: String(row.created_at),
		updatedAt: row.updated_at ? String(row.updated_at) : null,
	}));
}