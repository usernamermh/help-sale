/**
 * 门店级限额解析:平台把某店的额度写进 tenant_secrets(quota.*),这里带短缓存读出来给限流器用。
 *
 * 读不到(没配)= undefined,限流器回退全局配置;这样"某家门店愿意买更高额度"不用改全局配置。
 */
import type { DatabaseSync } from "node:sqlite";
import { readTenantConfig } from "../integrations_pi/tables/agents/tenant-config.js";

export interface TenantLimitOverride {
	requestPerMinute?: number;
	requestBurst?: number;
	agentConcurrency?: number;
}

export interface QuotaLimitResolver {
	(tenantId: string): TenantLimitOverride | undefined;
	/** 测试/配置变更后用:丢掉缓存 */
	clear(): void;
}

function positiveInt(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const value = Number(String(raw).trim());
	if (!Number.isFinite(value) || value <= 0) return undefined;
	return Math.floor(value);
}

/** cacheTtlMs:门店每次请求都会问一次限额,所以缓存几秒(配完额度最多几秒生效)。 */
export function createQuotaLimitResolver(db: DatabaseSync, cacheTtlMs = 5000): QuotaLimitResolver {
	const cache = new Map<string, { at: number; value: TenantLimitOverride | undefined }>();
	const resolver = ((tenantId: string): TenantLimitOverride | undefined => {
		const key = String(tenantId ?? "");
		if (!key) return undefined;
		const now = Date.now();
		const hit = cache.get(key);
		if (hit && now - hit.at < cacheTtlMs) return hit.value;
		let value: TenantLimitOverride | undefined;
		try {
			const requestPerMinute = positiveInt(readTenantConfig(db, key, "quota.requestPerMinute"));
			const requestBurst = positiveInt(readTenantConfig(db, key, "quota.requestBurst"));
			const agentConcurrency = positiveInt(readTenantConfig(db, key, "quota.agentConcurrency"));
			value = requestPerMinute === undefined && requestBurst === undefined && agentConcurrency === undefined
				? undefined
				: { requestPerMinute, requestBurst, agentConcurrency };
		} catch {
			value = undefined;
		}
		cache.set(key, { at: now, value });
		return value;
	}) as QuotaLimitResolver;
	resolver.clear = () => cache.clear();
	return resolver;
}
