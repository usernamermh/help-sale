import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../../apps/api/src/env.js";
import { appendSqlAudit, inspectSql } from "../../apps/api/src/services/sql-policy.js";

interface ToolContext { db: any; tenantId: string; }

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function delay(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

export async function execute(ctx: ToolContext, params: any) {
	const sql = String(params?.sql ?? "").trim();
	if (!sql) return { content: [{ type: "text", text: "请提供 sql 语句。" }] };
	// 权限与危险拦截:默认只读;写操作需 readOnly=false + confirmWrite=true,危险语句/无 WHERE 更新删除被拦截
	const decision = inspectSql(sql, { readOnly: params?.readOnly !== false, confirmWrite: params?.confirmWrite === true });
	if (!decision.allowed) {
		return { content: [{ type: "text", text: `[拦截] ${decision.reason}` }], details: { decision, sql } };
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
		const isSelect = /^(select|show|explain|describe|desc|pragma)\b/i.test(sql.trim());
		const text = isSelect ? JSON.stringify(rows).slice(0, 8000) : `执行完成,影响 ${(rows as { affectedRows?: number }).affectedRows ?? 0} 行`;
		// 写操作审计
		if (decision.mode === "write") {
			appendSqlAudit(path.join(repoRoot, "data"), { tenantId: ctx.tenantId, sql, mode: "write", readOnly: false, confirmWrite: params?.confirmWrite === true });
			await delay(0);
		}
		return {
			content: [{ type: "text", text: `[${decision.mode === "read" ? "只读" : "已写"}] ${text}` }],
			details: { decision, rows: isSelect ? rows : undefined, affectedRows: isSelect ? undefined : (rows as { affectedRows?: number }).affectedRows, fieldCount: Array.isArray(fields) ? fields.length : 0 },
		};
	} catch (error) {
		return { content: [{ type: "text", text: `sql 执行失败:${error instanceof Error ? error.message : String(error)}` }] };
	} finally {
		if (conn) await conn.end().catch(() => undefined);
	}
}