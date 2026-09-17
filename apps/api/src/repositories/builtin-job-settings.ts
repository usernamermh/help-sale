import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface BuiltinJobSetting {
	id: string;
	tenantId: string;
	jobKey: string;
	enabled: boolean;
	updatedAt: string;
}

/** 内置任务开关:无记录 = 默认启用;有记录则按记录启停。 */
export function getBuiltinJobEnabled(db: DatabaseSync, tenantId: string, jobKey: string): boolean {
	const row = db
		.prepare("SELECT enabled FROM builtin_job_settings WHERE tenant_id = ? AND job_key = ?")
		.get(tenantId, jobKey) as { enabled: number } | undefined;
	return row ? Number(row.enabled) === 1 : true;
}

export function setBuiltinJobEnabled(db: DatabaseSync, tenantId: string, jobKey: string, enabled: boolean): BuiltinJobSetting {
	const existing = db
		.prepare("SELECT id FROM builtin_job_settings WHERE tenant_id = ? AND job_key = ?")
		.get(tenantId, jobKey) as { id: string } | undefined;
	if (existing) {
		db.prepare("UPDATE builtin_job_settings SET enabled = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(enabled ? 1 : 0, existing.id);
	} else {
		db.prepare("INSERT INTO builtin_job_settings (id, tenant_id, job_key, enabled) VALUES (?,?,?,?)").run(randomUUID(), tenantId, jobKey, enabled ? 1 : 0);
	}
	const row = db
		.prepare("SELECT * FROM builtin_job_settings WHERE tenant_id = ? AND job_key = ?")
		.get(tenantId, jobKey) as Record<string, unknown>;
	return {
		id: String(row.id),
		tenantId: String(row.tenant_id),
		jobKey: String(row.job_key),
		enabled: Number(row.enabled) === 1,
		updatedAt: String(row.updated_at),
	};
}