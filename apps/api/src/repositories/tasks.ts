import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type TaskStatus = "pending" | "done" | "cancelled";

export interface TaskRecord {
	id: string;
	tenantId: string;
	customerId: string;
	analysisId: string | null;
	action: string;
	dueAt: string | null;
	status: TaskStatus;
	createdAt: string;
	completedAt: string | null;
	customerKey?: string;
	customerName?: string | null;
}

export interface CreateTaskInput {
	tenantId: string;
	customerId: string;
	analysisId?: string;
	action: string;
	dueAt?: string;
}

export interface ListTasksQuery {
	tenantId: string;
	status?: TaskStatus;
	customerId?: string;
	dueBefore?: string;
	limit?: number;
}

export function createTask(db: DatabaseSync, input: CreateTaskInput): TaskRecord {
	const id = randomUUID();
	db.prepare(
		"INSERT INTO next_step_tasks (id, tenant_id, customer_id, analysis_id, action, due_at) VALUES (?,?,?,?,?,?)",
	).run(id, input.tenantId, input.customerId, input.analysisId ?? null, input.action, input.dueAt ?? null);
	return getTask(db, input.tenantId, id)!;
}

export function getTask(db: DatabaseSync, tenantId: string, id: string): TaskRecord | undefined {
	const row = db
		.prepare(
			`SELECT t.*, c.key AS customer_key, c.name AS customer_name
			 FROM next_step_tasks t
			 LEFT JOIN customers c ON c.id = t.customer_id
			 WHERE t.tenant_id = ? AND t.id = ?`,
		)
		.get(tenantId, id) as Record<string, unknown> | undefined;
	return row ? mapRow(row) : undefined;
}

export function listTasks(db: DatabaseSync, query: ListTasksQuery): TaskRecord[] {
	const clauses: string[] = ["t.tenant_id = ?"];
	const params: (string | number)[] = [query.tenantId];
	if (query.status) {
		clauses.push("t.status = ?");
		params.push(query.status);
	}
	if (query.customerId) {
		clauses.push("t.customer_id = ?");
		params.push(query.customerId);
	}
	if (query.dueBefore) {
		clauses.push("(t.due_at IS NULL OR t.due_at <= ?)");
		params.push(query.dueBefore);
	}
	const limit = Math.min(query.limit ?? 50, 200);
	const rows = db
		.prepare(
			`SELECT t.*, c.key AS customer_key, c.name AS customer_name
			 FROM next_step_tasks t
			 LEFT JOIN customers c ON c.id = t.customer_id
			 WHERE ${clauses.join(" AND ")}
			 ORDER BY CASE WHEN t.due_at IS NULL THEN 1 ELSE 0 END, t.due_at ASC, t.created_at DESC
			 LIMIT ?`,
		)
		.all(...params, limit) as Record<string, unknown>[];
	return rows.map(mapRow);
}

export function setTaskStatus(db: DatabaseSync, tenantId: string, taskId: string, status: TaskStatus): TaskRecord | undefined {
	const existing = getTask(db, tenantId, taskId);
	if (!existing) return undefined;
	const completedAt = status === "done" ? new Date().toISOString().replace("T", " ").slice(0, 19) + "Z" : null;
	db.prepare("UPDATE next_step_tasks SET status = ?, completed_at = ? WHERE id = ?").run(status, completedAt, taskId);
	return getTask(db, tenantId, taskId);
}

function mapRow(row: Record<string, unknown>): TaskRecord {
	return {
		id: String(row.id),
		tenantId: String(row.tenant_id),
		customerId: String(row.customer_id),
		analysisId: row.analysis_id ? String(row.analysis_id) : null,
		action: String(row.action),
		dueAt: row.due_at ? String(row.due_at) : null,
		status: String(row.status) as TaskStatus,
		createdAt: String(row.created_at),
		completedAt: row.completed_at ? String(row.completed_at) : null,
		customerKey: row.customer_key ? String(row.customer_key) : undefined,
		customerName: row.customer_name != null ? String(row.customer_name) : undefined,
	};
}