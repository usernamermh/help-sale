import { parentPort } from "node:worker_threads";
import mysql from "mysql2/promise";

// MySQL 执行 worker:通过 SharedArrayBuffer 与主线程同步通信
// (主线程被 Atomics.wait 阻塞时,结果需放在共享内存而非 postMessage)
type Pool = mysql.Pool;
let pool: Pool | null = null;
let resultBuf: SharedArrayBuffer | null = null;
let resultView: Int32Array | null = null;

function writeResult(status: "ok" | "error", payload: Record<string, unknown>): void {
	if (!resultBuf || !resultView) return;
	try {
		const text = JSON.stringify({ status, ...payload });
		const bytes = Buffer.from(text, "utf8");
		if (bytes.length > resultBuf.byteLength - 8) {
			writeRaw({ status: "error", message: `结果超出共享内存上限(${bytes.length} > ${resultBuf.byteLength - 8})` });
			return;
		}
		const dv = new DataView(resultBuf);
		dv.setUint32(4, bytes.length, true);
		new Uint8Array(resultBuf, 8, bytes.length).set(bytes);
		Atomics.store(resultView, 0, 1);
		Atomics.notify(resultView, 0);
	} catch (error) {
		writeRaw({ status: "error", message: error instanceof Error ? error.message : String(error) });
	}
}
function writeRaw(payload: Record<string, unknown>): void {
	if (!resultBuf || !resultView) return;
	const text = JSON.stringify({ status: "error", ...payload });
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length > resultBuf.byteLength - 8) return;
	const dv = new DataView(resultBuf);
	dv.setUint32(4, bytes.length, true);
	new Uint8Array(resultBuf, 8, bytes.length).set(bytes);
	Atomics.store(resultView, 0, 1);
	Atomics.notify(resultView, 0);
}

parentPort!.on("message", async (msg: any) => {
	try {
		if (msg.kind === "init") {
			resultBuf = msg.resultBuf;
			resultView = new Int32Array(resultBuf as SharedArrayBuffer);
			pool = mysql.createPool({
				host: msg.host,
				port: msg.port,
				user: msg.user,
				password: msg.password,
				database: msg.database,
				connectionLimit: 2,
				multipleStatements: true,
				decimalNumbers: true,
				supportBigNumbers: false,
				timezone: "Z",
				charset: "utf8mb4",
			});
			await (pool as unknown as { query: (o: { sql: string }) => Promise<unknown> }).query({ sql: "SET sql_mode = CONCAT(@@sql_mode, ',PIPES_AS_CONCAT')" });
			if (msg.forceRebuild && msg.schemaSql) {
				const tableNames = [...msg.schemaSql.matchAll(/CREATE TABLE IF NOT EXISTS\s+([^\s(]+)/gi)].map((m: RegExpMatchArray) => m[1]);
				const drops = tableNames.map((t: string) => `DROP TABLE IF EXISTS \`${t.replace(/`/g, "")}\``).join("; ");
				await (pool as unknown as { query: (o: { sql: string }) => Promise<unknown> }).query({ sql: drops });
			}
			if (msg.schemaSql) await (pool as unknown as { query: (o: { sql: string }) => Promise<unknown> }).query({ sql: msg.schemaSql });
			writeResult("ok", { init: true });
			return;
		}
		if (msg.kind === "run") {
			if (!pool) throw new Error("worker 未初始化");
			const [rows] = (await (pool as unknown as { query: (o: unknown) => Promise<[unknown, unknown]> }).query({
				sql: msg.sql,
				values: Array.isArray(msg.params) ? msg.params : [],
				timeout: 15000,
			})) as [any, unknown];
			if (msg.stmtKind === "run") {
				writeResult("ok", { changes: Number(rows?.affectedRows ?? 0) });
			} else {
				writeResult("ok", { rows });
			}
			return;
		}
		if (msg.kind === "close") {
			if (pool) await pool.end().catch(() => undefined);
			writeResult("ok", { closed: true });
			parentPort!.close();
			return;
		}
		writeResult("error", { message: `未知指令 ${msg.kind}` });
	} catch (error) {
		writeResult("error", { message: error instanceof Error ? error.message : String(error) });
	}
});