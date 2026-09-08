import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../../apps/api/src/env.js";
import { appendSqlAudit, inspectSql } from "../../apps/api/src/services/sql-policy.js";

interface ToolContext { db: any; tenantId: string; }

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const resolveDbPath = (p: string) => (path.isAbsolute(p) ? p : path.join(repoRoot, p));

export async function execute(ctx: ToolContext, params: any) {
	const sql = String(params?.sql ?? "").trim();
	if (!sql) return { content: [{ type: "text", text: "请提供 sql 语句。" }] };
	// 权限与危险拦截:默认只读;写操作需 readOnly=false + confirmWrite=true,危险语句/无 WHERE 更新删除被拦截
	const decision = inspectSql(sql, { readOnly: params?.readOnly !== false, confirmWrite: params?.confirmWrite === true });
	if (!decision.allowed) {
		return { content: [{ type: "text", text: `[拦截] ${decision.reason}` }], details: { decision, sql } };
	}
	const values = Array.isArray(params?.values) ? (params.values as unknown[]) : [];

	if (config.dataMode === "mysql") {
		// mysql 模式:操作远程业务库(同步桥,内部完成 SQLite→MySQL 方言转换)
		const { createSyncMysqlDb } = await import("../../apps/api/src/db/mysql/client.js");
		const db = createSyncMysqlDb();
		try {
			return runStatement(db.prepare(sql), values, decision, ctx, sql);
		} finally {
			db.close();
		}
	}

	// local 模式:操作本地业务库(SQLite)
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(resolveDbPath(config.businessDbPath));
	try {
		db.exec("PRAGMA foreign_keys = ON");
		return runStatement(db.prepare(sql), values, decision, ctx, sql);
	} catch (error) {
		return { content: [{ type: "text", text: `sql 执行失败:${error instanceof Error ? error.message : String(error)}` }] };
	} finally {
		db.close();
	}
}

function runStatement(stmt: { all(...p: unknown[]): unknown[]; run(...p: unknown[]): { changes: number } }, values: unknown[], decision: { mode: "read" | "write"; allowed: boolean }, ctx: ToolContext, sql: string): { content: Array<{ type: "text"; text: string }>; details: unknown } {
	try {
		if (decision.mode === "read") {
			const rows = stmt.all(...values);
			return {
				content: [{ type: "text", text: `[只读] ${JSON.stringify(rows).slice(0, 8000)}` }],
				details: { decision, rows },
			};
		}
		const r = stmt.run(...values);
		// 写操作审计:跟随当前模式写入 data/sql-audit.log
		appendSqlAudit(path.join(repoRoot, "data"), { tenantId: ctx.tenantId, sql, mode: "write", readOnly: false, confirmWrite: true });
		return {
			content: [{ type: "text", text: `[已写] 执行完成,影响 ${r.changes ?? 0} 行` }],
			details: { decision, affectedRows: r.changes ?? 0 },
		};
	} catch (error) {
		return { content: [{ type: "text", text: `sql 执行失败:${error instanceof Error ? error.message : String(error)}` }] };
	}
}