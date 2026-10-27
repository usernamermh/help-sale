import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface WorkflowRunRecord {
	id: string;
	tenantId: string;
	workflowId: string;
	status: "running" | "success" | "failed";
	paramsJson: string | null;
	resultJson: string | null;
	error: string | null;
	createdAt: string;
	completedAt: string | null;
}

export function recordWorkflowRun(db: DatabaseSync, tenantId: string, workflowId: string, params: unknown): WorkflowRunRecord {
	const id = randomUUID();
	db.prepare(
		"INSERT INTO workflow_runs (id, tenant_id, workflow_id, status, params_json) VALUES (?,?,?,?,?)",
	).run(id, tenantId, workflowId, "running", params === undefined ? null : JSON.stringify(params));
	return getWorkflowRun(db, tenantId, id)!;
}

export function finishWorkflowRun(db: DatabaseSync, tenantId: string, id: string, input: { status: "success" | "failed"; result?: unknown; error?: string }): WorkflowRunRecord | undefined {
	db.prepare(
		"UPDATE workflow_runs SET status = ?, result_json = ?, error = ?, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND tenant_id = ?",
	).run(input.status, input.result === undefined ? null : JSON.stringify(input.result), input.error ?? null, id, tenantId);
	return getWorkflowRun(db, tenantId, id);
}

export function getWorkflowRun(db: DatabaseSync, tenantId: string, id: string): WorkflowRunRecord | undefined {
	const row = db.prepare("SELECT * FROM workflow_runs WHERE tenant_id = ? AND id = ?").get(tenantId, id) as Record<string, unknown> | undefined;
	return row ? mapRun(row) : undefined;
}

export function listWorkflowRuns(db: DatabaseSync, tenantId: string, workflowId: string, limit = 20): WorkflowRunRecord[] {
	return (db.prepare("SELECT * FROM workflow_runs WHERE tenant_id = ? AND workflow_id = ? ORDER BY created_at DESC LIMIT ?").all(tenantId, workflowId, limit) as Record<string, unknown>[]).map(mapRun);
}

function mapRun(row: Record<string, unknown>): WorkflowRunRecord {
	return {
		id: String(row.id),
		tenantId: String(row.tenant_id),
		workflowId: String(row.workflow_id),
		status: String(row.status) as WorkflowRunRecord["status"],
		paramsJson: row.params_json ? String(row.params_json) : null,
		resultJson: row.result_json ? String(row.result_json) : null,
		error: row.error ? String(row.error) : null,
		createdAt: String(row.created_at),
		completedAt: row.completed_at ? String(row.completed_at) : null,
	};
}
