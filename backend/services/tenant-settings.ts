/**
 * 门店设置的统一入口:按名字自动落到正确的表 ——
 *   tenant_config   非密钥(模型端点、用量限额…)
 *   tenant_secrets  密钥(模型 apiKey、web_search key、MCP 列表…)
 * 上层(门店自助 / 平台)只认"名字",不用关心存在哪张表。
 */
import type { DatabaseSync } from "node:sqlite";
import { deleteTenantConfig, listTenantConfig, readTenantConfig, TENANT_CONFIG_NAMES, writeTenantConfig } from "../integrations_pi/tables/agents/tenant-config.js";
import { deleteTenantSecret, listTenantSecrets, readTenantSecret, TENANT_SECRET_NAMES, writeTenantSecret } from "../integrations_pi/tables/agents/tenant-secrets.js";

/** 平台层可配的全部名字(密钥 + 非密钥)。 */
export const PLATFORM_SETTING_NAMES = [...TENANT_SECRET_NAMES, ...TENANT_CONFIG_NAMES] as const;

export function isConfigName(name: string): boolean {
	return (TENANT_CONFIG_NAMES as readonly string[]).includes(name);
}

/** 读设置:先看非密钥配置,再看密钥。 */
export function readSetting(db: DatabaseSync, tenantId: string, name: string): string | undefined {
	return isConfigName(name) ? readTenantConfig(db, tenantId, name) : readTenantSecret(db, tenantId, name);
}

export function writeSetting(db: DatabaseSync, tenantId: string, name: string, value: string): void {
	if (isConfigName(name)) writeTenantConfig(db, tenantId, name, value);
	else writeTenantSecret(db, tenantId, name, value);
}

export function deleteSetting(db: DatabaseSync, tenantId: string, name: string): boolean {
	return isConfigName(name) ? deleteTenantConfig(db, tenantId, name) : deleteTenantSecret(db, tenantId, name);
}

/** 合并列出该门店覆盖了哪些项(带更新时间和"存在哪张表")。 */
export function listSettings(db: DatabaseSync, tenantId: string): Array<{ name: string; updatedAt: string; kind: "config" | "secret" }> {
	return [
		...listTenantConfig(db, tenantId).map((row) => ({ ...row, kind: "config" as const })),
		...listTenantSecrets(db, tenantId).map((row) => ({ ...row, kind: "secret" as const })),
	].sort((a, b) => a.name.localeCompare(b.name));
}
