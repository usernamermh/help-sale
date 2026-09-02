import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface VehiclePlanRecord {
	id: string;
	tenantId: string;
	customerId: string;
	conversationId: string;
	requirement: string;
	planJson: string;
	createdAt: string;
}

export function createVehiclePlan(
	db: DatabaseSync,
	input: { tenantId: string; customerId: string; conversationId: string; requirement: string; planJson: string },
): VehiclePlanRecord {
	const id = randomUUID();
	db.prepare(
		"INSERT INTO vehicle_match_plans (id, tenant_id, customer_id, conversation_id, requirement, plan_json) VALUES (?,?,?,?,?,?)",
	).run(id, input.tenantId, input.customerId, input.conversationId, input.requirement, input.planJson);
	return db.prepare("SELECT * FROM vehicle_match_plans WHERE id = ?").get(id) as unknown as VehiclePlanRecord;
}

export function listVehiclePlansByCustomer(db: DatabaseSync, tenantId: string, customerId: string, limit = 10): VehiclePlanRecord[] {
	const rows = db
		.prepare(
			"SELECT * FROM vehicle_match_plans WHERE tenant_id = ? AND customer_id = ? ORDER BY created_at DESC LIMIT ?",
		)
		.all(tenantId, customerId, limit) as Record<string, unknown>[];
	return rows.map((row) => ({
		id: String(row.id),
		tenantId: String(row.tenant_id),
		customerId: String(row.customer_id),
		conversationId: String(row.conversation_id),
		requirement: String(row.requirement),
		planJson: String(row.plan_json),
		createdAt: String(row.created_at),
	}));
}