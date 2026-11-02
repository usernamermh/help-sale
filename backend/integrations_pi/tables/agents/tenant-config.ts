/** 门店级"非密钥配置"(tenant_config):模型端点、用量限额这类,和密钥分开存。 */
import type { DatabaseSync } from "node:sqlite";

export const TENANT_CONFIG_NAMES = ["model.modelId", "model.baseUrl", "model.proxy", "quota.requestPerMinute", "quota.requestBurst", "quota.agentConcurrency"] as const;
export type TenantConfigName = (typeof TENANT_CONFIG_NAMES)[number];

export interface TenantConfigRow { name: string; updatedAt: string; }

export function listTenantConfig(db: DatabaseSync, tenantId: string): TenantConfigRow[] {
	const rows = db.prepare("SELECT name, updated_at FROM tenant_config WHERE tenant_id = ? ORDER BY name").all(tenantId) as Array<Record<string, unknown>>;
	return rows.map((row) => ({ name: String(row.name), updatedAt: row.updated_at ? String(row.updated_at) : "" }));
}

export function readTenantConfig(db: DatabaseSync, tenantId: string, name: string): string | undefined {
	const row = db.prepare("SELECT value FROM tenant_config WHERE tenant_id = ? AND name = ?").get(tenantId, name) as { value?: string } | undefined;
	return row?.value === undefined ? undefined : String(row.value);
}

export function writeTenantConfig(db: DatabaseSync, tenantId: string, name: string, value: string): void {
	db.prepare(
		`INSERT INTO tenant_config (tenant_id, name, value, updated_at)
		 VALUES (?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
		 ON CONFLICT(tenant_id, name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
	).run(tenantId, name, value);
}

export function deleteTenantConfig(db: DatabaseSync, tenantId: string, name: string): boolean {
	return db.prepare("DELETE FROM tenant_config WHERE tenant_id = ? AND name = ?").run(tenantId, name).changes > 0;
}
