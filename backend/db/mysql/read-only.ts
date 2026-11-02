/**
 * SQL 工具的只读连接桥:读语句走只读账号(help_sale_ro,只有 SELECT),写语句仍走主账号。
 * 这样即使策略层被绕过,数据库层也没有第二把钥匙 —— 是"读写分账号"的那一道边界。
 * 配置留空(platform.config.yaml 的 mysql.readOnlyUser:"")表示不启用,读回退主连接。
 */
import { config } from "../../env.js";
import { SyncMysqlDb } from "./client.js";

let bridge: SyncMysqlDb | undefined;
let failed = false;

export function readOnlySqlBridge(): SyncMysqlDb | undefined {
	if (!config.mysqlReadOnlyUser) return undefined;
	if (bridge) return bridge;
	if (failed) return undefined;
	try {
		bridge = new SyncMysqlDb({
			host: config.mysqlHost,
			port: config.mysqlPort,
			user: config.mysqlReadOnlyUser,
			password: config.mysqlReadOnlyPassword,
			database: config.mysqlDatabase,
			connectionLimit: Math.max(2, Math.min(10, Math.floor(config.mysqlConnectionLimit / 2))),
			queryTimeoutMs: config.mysqlQueryTimeoutMs,
		});
		console.log("[mysql] SQL 工具的只读账号已接通(读走只读连接,写走主连接)");
		return bridge;
	} catch (error) {
		failed = true;
		console.warn(`[mysql] 只读账号不可用,读回退主连接:${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

export function closeReadOnlySqlBridge(): void {
	if (!bridge) return;
	bridge.close();
	bridge = undefined;
}
