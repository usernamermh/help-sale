import { parseTables, storageMode, str, bool, strList, strMap } from "./primitives.js";
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
		tenantId: str(file.tenant?.defaultTenantId, "tenant.defaultTenantId"),
		tenantHeaderAllowed: bool(file.tenant?.headerTenantAllowed, "tenant.headerTenantAllowed"),
		tenantTrustedIds: strList(file.tenant?.trustedTenantIds, "tenant.trustedTenantIds"),
		tenantDataIsolationMode: str(file.tenant?.dataIsolationMode, "tenant.dataIsolationMode") as "off" | "warn" | "enforce",
		tenantApiKeys: strMap(file.tenant?.apiKeys, "tenant.apiKeys"),
	};
}
