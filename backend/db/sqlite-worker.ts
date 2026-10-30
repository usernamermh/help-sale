import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";

/**
 * SQLite 单语句执行 worker:DatabaseSync 是同步 API,放在主线程会把整个服务卡住,
 * 也做不到"超时中止";放进 worker 后主线程可以按配置的超时直接 terminate。
 */
type SqlValue = string | number | bigint | null | Uint8Array;
const { dbPath, sql, values, stmtKind } = workerData as { dbPath: string; sql: string; values: SqlValue[]; stmtKind: "run" | "all" };

try {
	const db = new DatabaseSync(dbPath);
	try {
		db.exec("PRAGMA foreign_keys = ON");
		const stmt = db.prepare(sql);
		if (stmtKind === "run") {
			const r = stmt.run(...values);
			parentPort!.postMessage({ ok: true, changes: r.changes ?? 0 });
		} else {
			parentPort!.postMessage({ ok: true, rows: stmt.all(...values) });
		}
	} finally {
		db.close();
	}
} catch (error) {
	parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
}