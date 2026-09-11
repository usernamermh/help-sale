import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type TestDriveStatus = "scheduled" | "completed" | "cancelled";

export interface TestDriveInput {
	tenantId: string;
	customerId: string;
	salesId?: string | null;
	storeId?: string | null;
	vehicleId?: string | null;
	scheduledAt?: string;
}

export interface TestDriveRow {
	id: string;
	tenant_id: string;
	customer_id: string | null;
	sales_id: string | null;
	store_id: string | null;
	vehicle_id: string | null;
	scheduled_at: string | null;
	status: TestDriveStatus;
	feedback: string | null;
	competitor_compared: string | null;
	created_at: string;
	updated_at: string;
	customer_name?: string | null;
	customer_key?: string | null;
	vehicle_name?: string | null;
}

export function createTestDrive(db: DatabaseSync, input: TestDriveInput): TestDriveRow {
	const id = randomUUID();
	db.prepare(
		"INSERT INTO test_drives (id, tenant_id, customer_id, sales_id, store_id, vehicle_id, scheduled_at, status) VALUES (?,?,?,?,?,?,?, 'scheduled')",
	).run(id, input.tenantId, input.customerId, input.salesId ?? null, input.storeId ?? null, input.vehicleId ?? null, input.scheduledAt ?? null);
	return getTestDrive(db, input.tenantId, id)!;
}

export function getTestDrive(db: DatabaseSync, tenantId: string, id: string): TestDriveRow | undefined {
	const row = db
		.prepare(
			`SELECT td.*, c.name AS customer_name, c.key AS customer_key, v.model_name AS vehicle_name
			 FROM test_drives td
			 LEFT JOIN customers c ON c.id = td.customer_id
			 LEFT JOIN vehicles v ON v.id = td.vehicle_id
			 WHERE td.tenant_id = ? AND td.id = ?`,
		)
		.get(tenantId, id) as Record<string, unknown> | undefined;
	return row ? mapRow(row) : undefined;
}

export function listTestDrives(
	db: DatabaseSync,
	tenantId: string,
	input: { storeId?: string; status?: TestDriveStatus; limit?: number } = {},
): TestDriveRow[] {
	const clauses: string[] = ["td.tenant_id = ?"];
	const params: Array<string | number> = [tenantId];
	if (input.storeId) {
		clauses.push("td.store_id = ?");
		params.push(input.storeId);
	}
	if (input.status) {
		clauses.push("td.status = ?");
		params.push(input.status);
	}
	params.push(input.limit ?? 50);
	const rows = db
		.prepare(
			`SELECT td.*, c.name AS customer_name, c.key AS customer_key, v.model_name AS vehicle_name
			 FROM test_drives td
			 LEFT JOIN customers c ON c.id = td.customer_id
			 LEFT JOIN vehicles v ON v.id = td.vehicle_id
			 WHERE ${clauses.join(" AND ")}
			 ORDER BY (td.scheduled_at IS NULL), td.scheduled_at ASC
			 LIMIT ?`,
		)
		.all(...params) as Record<string, unknown>[];
	return rows.map(mapRow);
}

export function setTestDriveStatus(
	db: DatabaseSync,
	tenantId: string,
	id: string,
	status: TestDriveStatus,
	feedback?: string,
	competitorCompared?: string,
): TestDriveRow | undefined {
	const existing = getTestDrive(db, tenantId, id);
	if (!existing) return undefined;
	db.prepare(
		"UPDATE test_drives SET status = ?, feedback = ?, competitor_compared = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
	).run(status, feedback ?? existing.feedback, competitorCompared ?? existing.competitor_compared, id);
	return getTestDrive(db, tenantId, id);
}

function mapRow(row: Record<string, unknown>): TestDriveRow {
	return {
		id: String(row.id),
		tenant_id: String(row.tenant_id),
		customer_id: row.customer_id ? String(row.customer_id) : null,
		sales_id: row.sales_id ? String(row.sales_id) : null,
		store_id: row.store_id ? String(row.store_id) : null,
		vehicle_id: row.vehicle_id ? String(row.vehicle_id) : null,
		scheduled_at: row.scheduled_at ? String(row.scheduled_at) : null,
		status: String(row.status) as TestDriveStatus,
		feedback: row.feedback ? String(row.feedback) : null,
		competitor_compared: row.competitor_compared ? String(row.competitor_compared) : null,
		created_at: String(row.created_at),
		updated_at: String(row.updated_at),
		customer_name: row.customer_name ? String(row.customer_name) : null,
		customer_key: row.customer_key ? String(row.customer_key) : null,
		vehicle_name: row.vehicle_name ? String(row.vehicle_name) : null,
	};
}