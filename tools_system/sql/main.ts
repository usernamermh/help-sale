import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../../backend/env.js";
import { appendSqlAudit, guardSql, sanitizeRows, type SqlGuardResult } from "../../backend/services/sql-policy.js";
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
		// MySQL 服务端超时:客户端超时之外,再加一层优化器提示(只对 SELECT 生效)
		const withHint = (text: string): string => {
			const m = /^(\s*select\s+)/i.exec(text);
			if (!m) return text;
			return m[1] + "/*+ MAX_EXECUTION_TIME(" + Math.max(1000, Math.trunc(config.sqlTimeoutMs)) + ") */ " + text.slice(m[0].length);
		};
		const stmt = db.prepare(guard.mode === "read" && /^\s*select\b/i.test(guard.sql) ? withHint(guard.sql) : guard.sql);
		if (guard.mode === "write") return { changes: stmt.run(...guard.values).changes };
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
		stmtKind: guard.mode === "write" ? "run" : "all",
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
		appendSqlAudit(AUDIT_DIR, { tenantId, sql, mode: "blocked", readOnly, confirmWrite, ok: false, error: guard.reason, reason: guard.reason });
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
		// 结果层第二道防线:跨租户的行丢掉、敏感列不出(策略层管能不能执行,这里管返回了什么)
		const sanitized = sanitizeRows(result.rows ?? [], tenantId);
		const rows = sanitized.rows;
		const truncated = rows.length > guard.maxRows;
		const kept = truncated ? rows.slice(0, guard.maxRows) : rows;
		if (sanitized.crossTenant > 0) {
			appendSqlAudit(AUDIT_DIR, { tenantId, sql, mode, readOnly, confirmWrite, ok: false, error: "结果里出现跨租户行,已丢弃", crossTenant: sanitized.crossTenant });
		}
		appendSqlAudit(AUDIT_DIR, { tenantId, sql, mode, readOnly, confirmWrite, ok: true, rows: rows.length, crossTenant: sanitized.crossTenant, strippedColumns: sanitized.strippedColumns });
		const note = truncated ? `\n(结果共 ${rows.length} 行,已按 tools.sql.maxRows=${guard.maxRows} 截断)` : "";
		const warnings: string[] = [];
		if (sanitized.crossTenant > 0) warnings.push(`丢弃了 ${sanitized.crossTenant} 行跨租户数据`);
		if (sanitized.strippedColumns.length > 0) warnings.push(`已剔除敏感列:${sanitized.strippedColumns.join(", ")}`);
		const warnNote = warnings.length > 0 ? `\n(注意:${warnings.join(";")})` : "";
		return reply(`[只读] 共 ${rows.length} 行${note}${warnNote}\n${JSON.stringify(kept).slice(0, TEXT_LIMIT)}`, {
			decision: guard,
			rows: kept,
			rowCount: rows.length,
			truncated,
			crossTenant: sanitized.crossTenant,
			strippedColumns: sanitized.strippedColumns,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		appendSqlAudit(AUDIT_DIR, { tenantId, sql, mode, readOnly, confirmWrite, ok: false, error: message });
		return reply(`sql 执行失败:${message}`, { decision: guard, failed: true });
	}
}