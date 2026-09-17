import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface AutomationJob {
	id: string;
	tenantId: string;
	name: string;
	scheduleType: "daily" | "weekly" | "interval";
	intervalDays: number | null;
	weekday: number | null; // 1=周一 … 7=周日
	scheduleTime: string; // HH:MM
	description: string | null;
	actionJson: string;
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface AutomationJobInput {
	tenantId: string;
	name: string;
	scheduleType?: "daily" | "weekly" | "interval";
	intervalDays?: number | null;
	weekday?: number | null;
	scheduleTime: string;
	description?: string | null;
	action?: unknown;
	enabled?: boolean;
}

export function createAutomationJob(db: DatabaseSync, input: AutomationJobInput): AutomationJob {
	const id = randomUUID();
	db.prepare(
		"INSERT INTO automation_jobs (id, tenant_id, name, schedule_type, interval_days, weekday, schedule_time, description, action_json, enabled) VALUES (?,?,?,?,?,?,?,?,?,?)",
	).run(id, input.tenantId, input.name, input.scheduleType ?? "daily", input.intervalDays ?? null, input.weekday ?? null, input.scheduleTime, input.description ?? null, JSON.stringify(input.action ?? {}), input.enabled === false ? 0 : 1);
	return getAutomationJob(db, input.tenantId, id)!;
}

export function getAutomationJob(db: DatabaseSync, tenantId: string, id: string): AutomationJob | undefined {
	const row = db.prepare("SELECT * FROM automation_jobs WHERE tenant_id = ? AND id = ?").get(tenantId, id) as Record<string, unknown> | undefined;
	return row ? mapRow(row) : undefined;
}

export function listAutomationJobs(db: DatabaseSync, tenantId: string, enabledOnly = false): AutomationJob[] {
	const rows = db
		.prepare(`SELECT * FROM automation_jobs WHERE tenant_id = ?${enabledOnly ? " AND enabled = 1" : ""} ORDER BY schedule_type, schedule_time, created_at`)
		.all(tenantId) as Record<string, unknown>[];
	return rows.map(mapRow);
}

export function updateAutomationJob(
	db: DatabaseSync,
	tenantId: string,
	id: string,
	patch: Partial<Omit<AutomationJobInput, "tenantId">>,
): AutomationJob | undefined {
	const existing = getAutomationJob(db, tenantId, id);
	if (!existing) return undefined;
	db.prepare(
		`UPDATE automation_jobs SET name = ?, schedule_type = ?, interval_days = ?, weekday = ?, schedule_time = ?, description = ?, action_json = ?, enabled = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
	).run(
		patch.name ?? existing.name,
		patch.scheduleType ?? existing.scheduleType,
		patch.intervalDays !== undefined ? patch.intervalDays : existing.intervalDays,
		patch.weekday !== undefined ? patch.weekday : existing.weekday,
		patch.scheduleTime ?? existing.scheduleTime,
		patch.description !== undefined ? patch.description : existing.description,
		patch.action !== undefined ? JSON.stringify(patch.action) : existing.actionJson,
		patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : existing.enabled ? 1 : 0,
		id,
	);
	return getAutomationJob(db, tenantId, id);
}

export function deleteAutomationJob(db: DatabaseSync, tenantId: string, id: string): boolean {
	const existing = getAutomationJob(db, tenantId, id);
	if (!existing) return false;
	db.prepare("DELETE FROM automation_jobs WHERE tenant_id = ? AND id = ?").run(tenantId, id);
	return true;
}

function mapRow(row: Record<string, unknown>): AutomationJob {
	return {
		id: String(row.id),
		tenantId: String(row.tenant_id),
		name: String(row.name),
		scheduleType: String(row.schedule_type) as "daily" | "weekly" | "interval",
		intervalDays: row.interval_days != null ? Number(row.interval_days) : null,
		weekday: row.weekday != null ? Number(row.weekday) : null,
		scheduleTime: String(row.schedule_time),
		description: row.description ? String(row.description) : null,
		actionJson: String(row.action_json),
		enabled: Number(row.enabled ?? 1) === 1,
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}