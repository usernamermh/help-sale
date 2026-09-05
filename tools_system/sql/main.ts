import { config } from "../../apps/api/src/env.js";

interface ToolContext { db: any; tenantId: string; }

export async function execute(_ctx: ToolContext, params: any) {
	const sql = String(params?.sql ?? "").trim();
	if (!sql) return { content: [{ type: "text", text: "请提供 sql 语句。" }] };
	if (/;\s*\S/.test(sql.replace(/--[^\n]*/g, ""))) {
		return { content: [{ type: "text", text: "禁止多语句:一次只允许一条 SQL(去掉多余分号)。" }] };
	}
	let mysql: any;
	try {
		mysql = (await import("mysql2/promise")).default;
	} catch (error) {
		return { content: [{ type: "text", text: `mysql2 不可用:${error instanceof Error ? error.message : String(error)}` }] };
	}
	let conn: any;
	try {
		conn = await mysql.createConnection({ host: config.mysqlHost, port: config.mysqlPort, user: config.mysqlUser, password: config.mysqlPassword, database: config.mysqlDatabase, connectTimeout: 3000, multipleStatements: false });
		const [rows, fields] = await conn.query({ sql, values: Array.isArray(params?.values) ? params.values : [] });
		const isSelect = sql.trim().toUpperCase().startsWith("SELECT") || sql.trim().toUpperCase().startsWith("SHOW");
		const text = isSelect ? JSON.stringify(rows).slice(0, 4000) : `执行完成,影响 ${(rows as { affectedRows?: number }).affectedRows ?? 0} 行`;
		return { content: [{ type: "text", text }], details: { rows: isSelect ? rows : undefined, affectedRows: isSelect ? undefined : (rows as { affectedRows?: number }).affectedRows, fieldCount: Array.isArray(fields) ? fields.length : 0 } };
	} catch (error) {
		return { content: [{ type: "text", text: `sql 执行失败:${error instanceof Error ? error.message : String(error)}` }] };
	} finally {
		if (conn) await conn.end().catch(() => undefined);
	}
}