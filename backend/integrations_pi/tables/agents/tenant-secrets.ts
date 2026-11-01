/**
 * 每租户凭证覆盖(tenant_secrets)。
 *
 * 用途:全局配置里的模型端点/密钥、web_search key、MCP server 列表,都可以按租户覆盖一份,
 * 让"大租户自带密钥/自带外部系统"不需要改全局配置。
 *
 * 名字约定(与全局配置一一对应,便于对照):
 *   model.modelId / model.baseUrl / model.apiKey / model.proxy
 *   tools.webSearch.apiKey
 *   mcp.servers(JSON 数组,结构同 mcp.servers)
 */
import type { DatabaseSync } from "node:sqlite";

export const TENANT_SECRET_NAMES = ["model.modelId", "model.baseUrl", "model.apiKey", "model.proxy", "tools.webSearch.apiKey", "mcp.servers"] as const;
export type TenantSecretName = (typeof TENANT_SECRET_NAMES)[number];

export interface TenantSecretRow {
	name: string;
	updatedAt: string;
}

export function listTenantSecrets(db: DatabaseSync, tenantId: string): TenantSecretRow[] {
	const rows = db.prepare("SELECT name, updated_at FROM tenant_secrets WHERE tenant_id = ? ORDER BY name").all(tenantId) as Array<Record<string, unknown>>;
	return rows.map((row) => ({ name: String(row.name), updatedAt: row.updated_at ? String(row.updated_at) : "" }));
}

/** 取单个覆盖值;没有覆盖返回 undefined(调用方回退到全局配置)。 */
export function readTenantSecret(db: DatabaseSync, tenantId: string, name: string): string | undefined {
	const row = db.prepare("SELECT value FROM tenant_secrets WHERE tenant_id = ? AND name = ?").get(tenantId, name) as { value?: string } | undefined;
	return row?.value === undefined ? undefined : String(row.value);
}

export function writeTenantSecret(db: DatabaseSync, tenantId: string, name: string, value: string): void {
	db.prepare(
		`INSERT INTO tenant_secrets (tenant_id, name, value, updated_at)
		 VALUES (?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
		 ON CONFLICT(tenant_id, name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
	).run(tenantId, name, value);
}

export function deleteTenantSecret(db: DatabaseSync, tenantId: string, name: string): boolean {
	return db.prepare("DELETE FROM tenant_secrets WHERE tenant_id = ? AND name = ?").run(tenantId, name).changes > 0;
}