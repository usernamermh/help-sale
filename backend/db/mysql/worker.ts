import { parentPort } from "node:worker_threads";
import mysql from "mysql2/promise";

// MySQL 执行 worker:通过 SharedArrayBuffer 与主线程同步通信
// (主线程被 Atomics.wait 阻塞时,结果需放在共享内存而非 postMessage)
type Pool = mysql.Pool;
let pool: Pool | null = null;
/** 建表专用池:只有 schema.sql / 补列这些 DDL 需要 multipleStatements,查询池一律关掉 */
let schemaPool: Pool | null = null;
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

/**
 * 建表只做 CREATE TABLE IF NOT EXISTS —— 老库里"后来新增的列"不会被补上(实测:沉默客户唤醒报
 * Unknown column 'c.funnel_stage')。这里按 schema.sql 逐表比对 information_schema,只补缺列(ADD COLUMN),
 * 不改不删,因此对线上库安全;补列时去掉 NOT NULL(老表已有数据,没默认值的 NOT NULL 列加不上去)。
 */
/**
 * 建表只做 CREATE TABLE IF NOT EXISTS —— 老库里"后来新增的列/后来放大的列宽"都不会自动生效
 * (实测:沉默客户唤醒报 Unknown column 'c.funnel_stage'、周报报 Data too long for 'digest_date')。
 * 这里按 schema.sql 逐表比对 information_schema:缺列 ADD COLUMN、VARCHAR 长度不够 MODIFY,不改不删。
 */
async function ensureColumns(p: Pool, schemaSql: string): Promise<string[]> {
	const changes: string[] = [];
	const blocks = [...schemaSql.matchAll(/CREATE TABLE IF NOT EXISTS\s+`?([a-zA-Z_]+)`?\s*\(([\s\S]*?)\n\)\s*ENGINE/gi)];
	for (const block of blocks) {
		const table = block[1];
		const defs = new Map<string, string>();
		for (const rawLine of block[2].split("\n")) {
			const line = rawLine.trim().replace(/,$/, "");
			if (!line) continue;
			if (/^(PRIMARY|UNIQUE|KEY|INDEX|CONSTRAINT|FOREIGN|FULLTEXT)\b/i.test(line)) continue;
			const m = line.match(/^`?([a-zA-Z_][a-zA-Z0-9_]*)`?\s+([\s\S]+)$/);
			if (m) defs.set(m[1], line);
		}
		const [rows] = (await (p as unknown as { query: (o: unknown) => Promise<[Array<Record<string, unknown>>, unknown]> }).query({
			sql: "SELECT COLUMN_NAME AS name, DATA_TYPE AS type, CHARACTER_MAXIMUM_LENGTH AS len FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?",
			values: [table],
		})) as [Array<Record<string, unknown>>, unknown];
		const existing = new Map<string, { type: string; len: number }>();
		for (const r of rows) {
			const name = String(r.name ?? r.COLUMN_NAME ?? r.column_name ?? "").toLowerCase();
			const len = Number(r.len ?? r.CHARACTER_MAXIMUM_LENGTH ?? 0) || 0;
			existing.set(name, { type: String(r.type ?? r.DATA_TYPE ?? "").toLowerCase(), len });
		}
		for (const [name, ddl] of defs) {
			const have = existing.get(name.toLowerCase());
			if (!have) {
				const safe = /DEFAULT/i.test(ddl) ? ddl : ddl.replace(/\s+NOT NULL/i, "");
				await (p as unknown as { query: (o: unknown) => Promise<unknown> }).query({ sql: `ALTER TABLE \`${table}\` ADD COLUMN ${safe}` });
				changes.push(`${table}.${name}(新增)`);
				continue;
			}
			const want = ddl.match(/varchar\((\d+)\)/i);
			if (want && have.len > 0 && Number(want[1]) > have.len) {
				await (p as unknown as { query: (o: unknown) => Promise<unknown> }).query({ sql: `ALTER TABLE \`${table}\` MODIFY COLUMN ${ddl}` });
				changes.push(`${table}.${name}(列宽 ${have.len}→${want[1]})`);
			}
		}
	}
	return changes;
}

parentPort!.on("message", async (msg: any) => {
	try {
		if (msg.kind === "init") {
			resultBuf = msg.resultBuf;
			resultView = new Int32Array(resultBuf as SharedArrayBuffer);
			const baseOptions = {
				host: msg.host,
				port: msg.port,
				user: msg.user,
				password: msg.password,
				database: msg.database,
				// 池大小来自配置(隔离目标:单个租户的慢查询不该占满连接池)
				connectionLimit: Number(msg.connectionLimit) > 0 ? Number(msg.connectionLimit) : 10,
				decimalNumbers: true,
				supportBigNumbers: false,
				timezone: "Z",
				charset: "utf8mb4",
			};
			// 查询池:multipleStatements=false —— 就算策略层漏了一条,驱动也不会把 `a; b` 当两条执行
			pool = mysql.createPool({ ...baseOptions, multipleStatements: false });
			await (pool as unknown as { query: (o: { sql: string }) => Promise<unknown> }).query({ sql: "SET sql_mode = CONCAT(@@sql_mode, ',PIPES_AS_CONCAT')" });
			if (msg.schemaSql) {
				// 建表池:允许一次执行整份 schema.sql(含多条 CREATE),用完即关
				schemaPool = mysql.createPool({ ...baseOptions, multipleStatements: true });
				if (msg.forceRebuild) {
					const tableNames = [...msg.schemaSql.matchAll(/CREATE TABLE IF NOT EXISTS\s+([^\s(]+)/gi)].map((m: RegExpMatchArray) => m[1]);
					const drops = tableNames.map((t: string) => `DROP TABLE IF EXISTS \`${t.replace(/`/g, "")}\``).join("; ");
					await (schemaPool as unknown as { query: (o: { sql: string }) => Promise<unknown> }).query({ sql: drops });
				}
				await (schemaPool as unknown as { query: (o: { sql: string }) => Promise<unknown> }).query({ sql: msg.schemaSql });
			}
			const addedColumns = msg.schemaSql && schemaPool ? await ensureColumns(schemaPool, String(msg.schemaSql)) : [];
			if (addedColumns.length > 0) console.warn(`[mysql] 启动补列 ${addedColumns.length} 个: ${addedColumns.join(", ")}`);
			if (schemaPool) { await schemaPool.end().catch(() => undefined); schemaPool = null; }
			writeResult("ok", { init: true, addedColumns });
			return;
		}
		if (msg.kind === "run") {
			if (!pool) throw new Error("worker 未初始化");
			const [rows] = (await (pool as unknown as { query: (o: unknown) => Promise<[unknown, unknown]> }).query({
				sql: msg.sql,
				values: Array.isArray(msg.params) ? msg.params : [],
				timeout: Number(msg.timeoutMs) > 0 ? Number(msg.timeoutMs) : 15000,
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
			if (schemaPool) await schemaPool.end().catch(() => undefined);
			writeResult("ok", { closed: true });
			parentPort!.close();
			return;
		}
		writeResult("error", { message: `未知指令 ${msg.kind}` });
	} catch (error) {
		writeResult("error", { message: error instanceof Error ? error.message : String(error) });
	}
});