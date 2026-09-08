import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface CapabilityState {
	name: string;
	enabled: boolean;
	updatedAt?: string;
}

export function listCapabilityStates(db: DatabaseSync, tenantId: string): CapabilityState[] {
	const rows = db.prepare("SELECT * FROM agent_capabilities WHERE tenant_id = ?").all(tenantId) as Array<Record<string, unknown>>;
	return rows.map((r) => ({
		name: String(r.capability_name),
		enabled: Number(r.enabled) !== 0,
		updatedAt: r.updated_at ? String(r.updated_at) : undefined,
	}));
}

export function setCapabilityEnabled(db: DatabaseSync, tenantId: string, name: string, enabled: boolean): void {
	db.prepare(
		`INSERT INTO agent_capabilities (tenant_id, capability_name, enabled, updated_at)
		 VALUES (?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
		 ON CONFLICT(tenant_id, capability_name) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
	).run(tenantId, name, enabled ? 1 : 0);
}

export interface WorkflowRecord {
	id: string;
	tenantId: string;
	name: string;
	description: string;
	steps: unknown[];
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface CreateWorkflowInput {
	name: string;
	description?: string;
	steps?: unknown[];
	enabled?: boolean;
}

export function createWorkflow(db: DatabaseSync, tenantId: string, input: CreateWorkflowInput): WorkflowRecord {
	const id = randomUUID();
	db.prepare("INSERT INTO workflows (id, tenant_id, name, description, steps_json, enabled) VALUES (?,?,?,?,?,?)").run(
		id,
		tenantId,
		input.name,
		input.description ?? "",
		JSON.stringify(input.steps ?? []),
		input.enabled === false ? 0 : 1,
	);
	return getWorkflow(db, tenantId, id)!;
}

export function getWorkflow(db: DatabaseSync, tenantId: string, id: string): WorkflowRecord | undefined {
	const row = db.prepare("SELECT * FROM workflows WHERE tenant_id = ? AND id = ?").get(tenantId, id) as Record<string, unknown> | undefined;
	return row ? mapWorkflow(row) : undefined;
}

export function listWorkflows(db: DatabaseSync, tenantId: string): WorkflowRecord[] {
	const rows = db.prepare("SELECT * FROM workflows WHERE tenant_id = ? ORDER BY updated_at DESC").all(tenantId) as Array<Record<string, unknown>>;
	return rows.map(mapWorkflow);
}

function mapWorkflow(row: Record<string, unknown>): WorkflowRecord {
	let steps: unknown[] = [];
	try {
		steps = JSON.parse(String(row.steps_json ?? "[]"));
	} catch {
		steps = [];
	}
	return {
		id: String(row.id),
		tenantId: String(row.tenant_id),
		name: String(row.name),
		description: String(row.description ?? ""),
		steps,
		enabled: Number(row.enabled) !== 0,
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}