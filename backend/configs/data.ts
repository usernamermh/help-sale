import { parseTables, storageMode, str, num, bool, strList, strMap } from "./primitives.js";
import type { FileConfig } from "./file.js";
import type { DataConfig } from "./types.js";

/**
 * 对应 help-sale.config.yaml 的 `data` 与 `tenant` 两段:数据存储模式、业务表名映射、各类路径与默认租户。
 * 全部必填:data.tables 是表名的唯一事实源(17 张逻辑表都要写),data.mode 只允许 local / mysql。
 */
export function loadDataConfig(file: FileConfig): DataConfig {
	return {
		dataMode: storageMode(file.data?.mode, "data.mode"),
		databaseId: str(file.data?.databaseId, "data.databaseId"),
		tables: parseTables(file.data?.tables, "data.tables"),
		dataDir: str(file.data?.dataDir, "data.dataDir"),
		memoryFile: str(file.data?.memoryFile, "data.memoryFile"),
		businessDbPath: str(file.data?.businessDbPath, "data.businessDbPath"),
		sessionDbPath: str(file.data?.sessionDbPath, "data.sessionDbPath"),
		tenantId: str(file.platform?.defaultTenantId, "platform.defaultTenantId"),
		tenantHeaderAllowed: bool(file.platform?.headerTenantAllowed, "platform.headerTenantAllowed"),
		tenantDataIsolationMode: str(file.platform?.dataIsolationMode, "platform.dataIsolationMode") as "off" | "warn" | "enforce",
		tenantApiKeys: strMap(file.platform?.apiKeys, "platform.apiKeys"),
		tenantRateLimitEnabled: bool(file.platform?.rateLimit?.enabled, "platform.rateLimit.enabled"),
		tenantRequestPerMinute: num(file.platform?.rateLimit?.requestPerMinute, "platform.rateLimit.requestPerMinute"),
		tenantRequestBurst: num(file.platform?.rateLimit?.requestBurst, "platform.rateLimit.requestBurst"),
		tenantAgentConcurrency: num(file.platform?.rateLimit?.agentConcurrency, "platform.rateLimit.agentConcurrency"),
		tenantRetryAfterSeconds: num(file.platform?.rateLimit?.retryAfterSeconds, "platform.rateLimit.retryAfterSeconds"),
	};
}
