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
async function ensureColumns(p: Pool, schemaSql: string, dryRun = false): Promise<string[]> {
	const changes: string[] = [];
	// 只读自检时先看表在不在:表都不存在的话,逐列比对会把"整张表"误报成一堆缺列
	const [tableRows] = (await (p as unknown as { query: (o: unknown) => Promise<[Array<Record<string, unknown>>, unknown]> }).query({
		sql: "SELECT TABLE_NAME AS name FROM information_schema.tables WHERE table_schema = DATABASE()",
	})) as [Array<Record<string, unknown>>, unknown];
	const existingTables = new Set(tableRows.map((r) => String(r.name ?? "").toLowerCase()));
	const blocks = [...schemaSql.matchAll(/CREATE TABLE IF NOT EXISTS\s+`?([a-zA-Z_]+)`?\s*\(([\s\S]*?)\n\)\s*ENGINE/gi)];
	for (const block of blocks) {
		const table = block[1];
		if (!existingTables.has(table.toLowerCase())) {
			changes.push(`${table}(缺表)`);
			continue;
		}
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
				if (!dryRun) await (p as unknown as { query: (o: unknown) => Promise<unknown> }).query({ sql: `ALTER TABLE \`${table}\` ADD COLUMN ${safe}` });
				changes.push(`${table}.${name}(新增列)`);
				continue;
			}
			const want = ddl.match(/varchar\((\d+)\)/i);
			if (want && have.len > 0 && Number(want[1]) > have.len) {
				if (!dryRun) await (p as unknown as { query: (o: unknown) => Promise<unknown> }).query({ sql: `ALTER TABLE \`${table}\` MODIFY COLUMN ${ddl}` });
				changes.push(`${table}.${name}(列宽 ${have.len}→${want[1]})`);
				continue;
			}
			// 类型升级(只升不降):VARCHAR → TEXT/MEDIUMTEXT,或 TEXT → MEDIUMTEXT。
			// 用于修"早期把长文本列写成 VARCHAR(255),MySQL 模式下写入直接报 Data too long"这类问题。
			const textRank: Record<string, number> = { varchar: 1, char: 1, tinytext: 2, text: 2, mediumtext: 3, longtext: 4 };
			// 注意:ddl 是"列名 + 类型"整行,必须剥掉列名再判断类型,否则 ^ 锚定永远匹配不上
			const typePart = ddl.replace(/^`?[a-zA-Z_][a-zA-Z0-9_]*`?\s+/, "");
			const wantText = /^(tinytext|text|mediumtext|longtext)\b/i.exec(typePart);
			const haveRank = textRank[have.type] ?? 0;
			const wantRank = wantText ? textRank[wantText[1].toLowerCase()] ?? 0 : 0;
			if (wantRank > haveRank && haveRank > 0) {
				if (!dryRun) await (p as unknown as { query: (o: unknown) => Promise<unknown> }).query({ sql: `ALTER TABLE \`${table}\` MODIFY COLUMN ${ddl}` });
				changes.push(`${table}.${name}(类型 ${have.type}→${wantText![1].toLowerCase()})`);
			}
		}
		changes.push(...(await ensureIndexes(p, table, block[2], dryRun)));
		// 主键变更不自动执行:只告警并指向迁移脚本
		const pkNotice = await primaryKeyNotice(p, table, block[2]);
		if (pkNotice) changes.push(pkNotice);
	}
	return changes;
}

/**
 * 补索引:按 schema 里的 KEY / UNIQUE KEY 定义比对 information_schema.statistics,
 * **按列组合**判断是否已存在(不依赖索引名,兼容 MySQL 自动命名的 UNIQUE(col1,col2))。
 * ADD INDEX 在 MySQL 8 是 online 操作,且幂等,所以放进启动自愈是安全的。
 */
/**
 * 主键体检:多列主键(如 (tenant_id, id))不自动改 —— 重建表代价大,
 * 只返回告警文本,由运维按 scripts/mysql-pk-rebuild.sql 在维护窗口执行。
 */
async function primaryKeyNotice(p: Pool, table: string, body: string): Promise<string | null> {
	const want = /PRIMARY KEY\s*\(([^)]*)\)/i.exec(body);
	if (!want) return null;
	const wantCols = want[1].split(",").map((c) => c.trim().replace(/`/g, "").toLowerCase()).filter(Boolean);
	if (wantCols.length < 2) return null;
	const [rows] = (await (p as unknown as { query: (o: unknown) => Promise<[Array<Record<string, unknown>>, unknown]> }).query({
		sql: "SELECT COLUMN_NAME AS col FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = 'PRIMARY' ORDER BY SEQ_IN_INDEX",
		values: [table],
	})) as [Array<Record<string, unknown>>, unknown];
	const haveCols = rows.map((r) => String(r.col).toLowerCase());
	if (haveCols.join(",") === wantCols.join(",")) return null;
	// 线上主键多带一列(如分区要求把 created_at 并进主键)也算达标:只要期望的列是前缀即可
	if (wantCols.every((c, i) => haveCols[i] === c)) return null;
	return `${table}(主键 ${haveCols.join("+") || "无"} → ${wantCols.join("+")},需按 scripts/mysql-pk-rebuild.sql 迁移)`;
}

async function ensureIndexes(p: Pool, table: string, body: string, dryRun = false): Promise<string[]> {
	const changes: string[] = [];
	const wanted = new Map<string, { unique: boolean; cols: string[]; ddl: string }>();
	for (const rawLine of body.split("\n")) {
		const line = rawLine.trim().replace(/,$/, "");
		if (!line) continue;
		const m = /^(UNIQUE\s+)?(?:KEY|INDEX)\s+`?(\w+)`?\s*\(([^)]*)\)/i.exec(line);
		const mUnnamed = /^UNIQUE\s*\(([^)]*)\)/i.exec(line);
		const unique = Boolean(m?.[1] ?? mUnnamed);
		const colsRaw = m?.[3] ?? mUnnamed?.[1];
		if (!colsRaw) continue;
		const cols = colsRaw
			.split(",")
			.map((c) => c.trim().replace(/`/g, "").replace(/\s+(ASC|DESC)$/i, "").split(/\s+/)[0].toLowerCase())
			.filter(Boolean);
		if (cols.length === 0) continue;
		const name = m?.[2] ?? `uq_${table}_${cols.join("_")}`;
		wanted.set(cols.join(","), { unique, cols, ddl: `${unique ? "UNIQUE KEY" : "KEY"} \`${name.substring(0, 60)}\` (${cols.map((c) => `\`${c}\``).join(", ")})` });
	}
	if (wanted.size === 0) return changes;

	const [rows] = (await (p as unknown as { query: (o: unknown) => Promise<[Array<Record<string, unknown>>, unknown]> }).query({
		sql: "SELECT INDEX_NAME AS name, SEQ_IN_INDEX AS seq, COLUMN_NAME AS col, NON_UNIQUE AS nu FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX",
		values: [table],
	})) as [Array<Record<string, unknown>>, unknown];
	const existingSig = new Set<string>();
	const grouped = new Map<string, { cols: string[]; unique: boolean }>();
	for (const r of rows) {
		if (String(r.name) === "PRIMARY") continue;
		const key = String(r.name);
		const entry = grouped.get(key) ?? { cols: [], unique: Number(r.nu) === 0 };
		entry.cols.push(String(r.col).toLowerCase());
		grouped.set(key, entry);
	}
	// 签名 = 唯一性 + 列组合:普通索引不能顶替唯一索引(否则 UNIQUE 定义会被静默跳过)
	for (const entry of grouped.values()) existingSig.add(`${entry.unique ? "u" : "n"}:${entry.cols.join(",")}`);

	for (const [sig, def] of wanted) {
		const wantSig = `${def.unique ? "u" : "n"}:${sig}`;
		if (existingSig.has(wantSig)) continue;
		if (!dryRun) await (p as unknown as { query: (o: unknown) => Promise<unknown> }).query({ sql: `ALTER TABLE \`${table}\` ADD ${def.ddl}` });
		changes.push(`${table}.[${sig}](${def.unique ? "缺唯一索引" : "缺索引"})`);
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
			// autoMigrate=false:只做只读结构自检(GET 信息只读 information_schema),给最小权限账号用
			const dryRun = msg.autoMigrate === false;
			let structureChanges: string[] = [];
			if (msg.schemaSql) {
				if (dryRun) {
					structureChanges = await ensureColumns(pool, String(msg.schemaSql), true);
					if (structureChanges.length > 0) {
						console.warn(`[mysql] 结构自检发现 ${structureChanges.length} 项与 schema 不一致(不会自动执行,需按 scripts/ 下的脚本处理): ${structureChanges.join(", ")}`);
					}
				} else {
					// 建表池:允许一次执行整份 schema.sql(含多条 CREATE),用完即关
					schemaPool = mysql.createPool({ ...baseOptions, multipleStatements: true });
					if (msg.forceRebuild) {
						const tableNames = [...msg.schemaSql.matchAll(/CREATE TABLE IF NOT EXISTS\s+([^\s(]+)/gi)].map((m: RegExpMatchArray) => m[1]);
						const drops = tableNames.map((t: string) => `DROP TABLE IF EXISTS \`${t.replace(/`/g, "")}\``).join("; ");
						await (schemaPool as unknown as { query: (o: { sql: string }) => Promise<unknown> }).query({ sql: drops });
					}
					await (schemaPool as unknown as { query: (o: { sql: string }) => Promise<unknown> }).query({ sql: msg.schemaSql });
					structureChanges = await ensureColumns(schemaPool, String(msg.schemaSql), false);
					if (structureChanges.length > 0) console.warn(`[mysql] 启动结构变更 ${structureChanges.length} 项: ${structureChanges.join(", ")}`);
				}
			}
			if (schemaPool) { await schemaPool.end().catch(() => undefined); schemaPool = null; }
			writeResult("ok", { init: true, addedColumns: structureChanges, autoMigrate: !dryRun });
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
