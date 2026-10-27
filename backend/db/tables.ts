import { config } from "../env.js";

/**
 * 业务表名映射(来自 help-sale.config.yaml 的 data.tables):
 * 仓库层 SQL 应统一引用本常量,切换 local/mysql 或远程库实际表名时无需改代码。
 */
export const tables: Record<string, string> = config.tables;

export type TableName = keyof typeof tables;