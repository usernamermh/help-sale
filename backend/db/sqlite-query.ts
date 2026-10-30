import { Worker } from "node:worker_threads";

/**
 * 在 worker 里执行一条 SQLite 语句,超时直接终止 worker。
 * 这样既不会阻塞主线程(同步 API 的副作用),也能按配置给出确定的超时行为。
 */
export function runSqliteStatement(opts: {
	dbPath: string;
	sql: string;
	values: unknown[];
	stmtKind: "run" | "all";
	timeoutMs: number;
}): Promise<{ rows?: unknown[]; changes?: number }> {
	return new Promise((resolve, reject) => {
		const worker = new Worker(new URL("./sqlite-worker.js", import.meta.url), {
			workerData: { dbPath: opts.dbPath, sql: opts.sql, values: opts.values, stmtKind: opts.stmtKind },
		});
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			void worker.terminate();
			reject(new Error(`sqlite 执行超时(${opts.timeoutMs}ms),已中止`));
		}, Math.max(1000, opts.timeoutMs));
		worker.once("message", (msg: { ok: boolean; rows?: unknown[]; changes?: number; error?: string }) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			void worker.terminate();
			if (msg.ok) resolve({ rows: msg.rows, changes: msg.changes });
			else reject(new Error(msg.error ?? "sqlite 执行失败"));
		});
		worker.once("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(error instanceof Error ? error : new Error(String(error)));
		});
	});
}