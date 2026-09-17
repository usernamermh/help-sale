import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type AutomationJobType = "morning_digest" | "weekly_report" | "silent_wakeup" | "reflection" | (string & {});

export interface AutomationRun {
	id: string;
	tenantId: string;
	jobType: AutomationJobType;
	runDate: string;
	status: "success" | "error" | "skipped";
	summary: string | null;
	detailJson: string | null;
	createdAt: string;
}

export interface AutomationRunInput {
	tenantId: string;
	jobType: AutomationJobType;
	runDate: string;
	status: AutomationRun["status"];
	summary?: string;
	detail?: unknown;
}

export function recordAutomationRun(db: DatabaseSync, input: AutomationRunInput): AutomationRun {
	const id = randomUUID();
	db.prepare(
		"INSERT INTO automation_runs (id, tenant_id, job_type, run_date, status, summary, detail_json) VALUES (?,?,?,?,?,?,?)",
	).run(id, input.tenantId, input.jobType, input.runDate, input.status, input.summary ?? null, input.detail !== undefined ? JSON.stringify(input.detail) : null);
	return getAutomationRun(db, input.tenantId, id)!;
}

export function getAutomationRun(db: DatabaseSync, tenantId: string, id: string): AutomationRun | undefined {
	const row = db.prepare("SELECT * FROM automation_runs WHERE tenant_id = ? AND id = ?").get(tenantId, id) as Record<string, unknown> | undefined;
	return row ? mapRow(row) : undefined;
}

/** 当天该任务是否已执行(用于幂等:同一天不重复跑)。 */
export function hasAutomationRunOn(db: DatabaseSync, tenantId: string, jobType: string, runDate: string): boolean {
	const row = db
		.prepare("SELECT id FROM automation_runs WHERE tenant_id = ? AND job_type = ? AND run_date = ? LIMIT 1")
		.get(tenantId, jobType, runDate);
	return Boolean(row);
}

export function listAutomationRuns(db: DatabaseSync, tenantId: string, limit = 50): AutomationRun[] {
	const rows = db
		.prepare("SELECT * FROM automation_runs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?")
		.all(tenantId, limit) as Record<string, unknown>[];
	return rows.map(mapRow);
}

/** 全部租户 ID(自动任务按租户循环执行)。 */
export function listTenantIds(db: DatabaseSync): string[] {
	const rows = db.prepare("SELECT id FROM tenants ORDER BY id").all() as Array<{ id: string }>;
	return rows.map((r) => r.id);
}

function mapRow(row: Record<string, unknown>): AutomationRun {
	return {
		id: String(row.id),
		tenantId: String(row.tenant_id),
		jobType: String(row.job_type) as AutomationJobType,
		runDate: String(row.run_date),
		status: String(row.status) as AutomationRun["status"],
		summary: row.summary ? String(row.summary) : null,
		detailJson: row.detail_json ? String(row.detail_json) : null,
		createdAt: String(row.created_at),
	};
}