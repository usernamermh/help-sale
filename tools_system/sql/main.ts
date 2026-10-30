import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../../backend/env.js";
import { appendSqlAudit, guardSql, type SqlGuardResult } from "../../backend/services/sql-policy.js";
import { runSqliteStatement } from "../../backend/db/sqlite-query.js";

/**
 * 业务库查询/写入工具。安全策略全在 backend/services/sql-policy.ts:
 * 默认只读、写操作双确认、DDL/权限/运维语句黑名单、危险函数、多语句、PRAGMA 白名单、
 * WITH 主语句判定、恒真条件、业务表强制 :tenantId 租户隔离、读语句自动补 LIMIT。
 * 这里只负责:执行、结果截断、审计、超时。
 */

interface ToolContext { db: unknown; tenantId: string; }

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const resolveDbPath = (p: string) => (path.isAbsolute(p) ? p : path.join(repoRoot, p));
const AUDIT_DIR = path.join(repoRoot, "data");
const TEXT_LIMIT = 8000;

/** 需要租户隔离的业务表(除去 tenants 本身) */
function tenantTables(): string[] {
	return Object.entries(config.tables)
		.filter(([key]) => key !== "tenants")
		.map(([, name]) => String(name).toLowerCase());
}

function reply(text: string, details?: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text }], details: details ?? null };
}

async function runMysql(guard: SqlGuardResult): Promise<{ rows?: unknown[]; changes?: number }> {
	const { createSyncMysqlDb } = await import("../../backend/db/mysql/client.js");
	const db = createSyncMysqlDb();
	try {
		const stmt = db.prepare(guard.sql);
		if (guard.mode === "run") return { changes: stmt.run(...guard.values).changes };
		return { rows: stmt.all(...guard.values) };
	} finally {
		db.close();
	}
}

async function runLocal(guard: SqlGuardResult): Promise<{ rows?: unknown[]; changes?: number }> {
	return runSqliteStatement({
		dbPath: resolveDbPath(config.businessDbPath),
		sql: guard.sql,
		values: guard.values,
		stmtKind: guard.mode === "run" ? "run" : "all",
		timeoutMs: config.sqlTimeoutMs,
	});
}

export async function execute(ctx: ToolContext, params: any) {
	const sql = String(params?.sql ?? "").trim();
	if (!sql) return reply("请提供 sql 语句。");
	const tenantId = String(ctx?.tenantId ?? "").trim() || config.tenantId;
	const readOnly = params?.readOnly !== false;
	const confirmWrite = params?.confirmWrite === true;
	const guard = guardSql(sql, Array.isArray(params?.values) ? (params.values as unknown[]) : [], {
		readOnly,
		confirmWrite,
		extraBlockedKeywords: config.sqlExtraBlockedKeywords,
		maxRows: config.sqlMaxRows,
		tenantId,
		tenantTables: tenantTables(),
		dialect: config.dataMode === "mysql" ? "mysql" : "sqlite",
	});
	if (!guard.allowed) {
		appendSqlAudit(AUDIT_DIR, { tenantId, sql, mode: "blocked", readOnly, confirmWrite, ok: false, error: guard.reason });
		return reply(`[拦截] ${guard.reason}`, { decision: guard, blocked: true });
	}
	// mode 只有 read / write 两种能走到这里;写操作内部用 stmt.run
	const mode: "read" | "write" = guard.mode === "read" ? "read" : "write";
	const guardForRun: SqlGuardResult = { ...guard, mode, allowed: true };
	try {
		const result = config.dataMode === "mysql" ? await runMysql(guardForRun) : await runLocal(guardForRun);
		if (mode === "write") {
			appendSqlAudit(AUDIT_DIR, { tenantId, sql, mode, readOnly, confirmWrite, ok: true, rows: result.changes ?? 0 });
			return reply(`[已写] 执行完成,影响 ${result.changes ?? 0} 行`, { decision: guard, affectedRows: result.changes ?? 0 });
		}
		const rows = result.rows ?? [];
		const truncated = rows.length > guard.maxRows;
		const kept = truncated ? rows.slice(0, guard.maxRows) : rows;
		appendSqlAudit(AUDIT_DIR, { tenantId, sql, mode, readOnly, confirmWrite, ok: true, rows: rows.length });
		const note = truncated ? `\n(结果共 ${rows.length} 行,已按 tools.sql.maxRows=${guard.maxRows} 截断)` : "";
		return reply(`[只读] 共 ${rows.length} 行${note}\n${JSON.stringify(kept).slice(0, TEXT_LIMIT)}`, {
			decision: guard,
			rows: kept,
			rowCount: rows.length,
			truncated,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		appendSqlAudit(AUDIT_DIR, { tenantId, sql, mode, readOnly, confirmWrite, ok: false, error: message });
		return reply(`sql 执行失败:${message}`, { decision: guard, failed: true });
	}
}