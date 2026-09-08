import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

/**
 * SQL 工具权限与风险拦截策略:
 * - 默认只读:SELECT/SHOW/EXPLAIN/DESCRIBE/PRAGMA 放行;
 * - 写操作(INSERT/UPDATE/DELETE/REPLACE/WITH 等)必须显式 readOnly=false 且 confirmWrite=true;
 * - 危险语句黑名单:DROP/TRUNCATE/ALTER/GRANT/REVOKE 直接拦截;
 * - UPDATE/DELETE 必须带 WHERE,防止全表更新/删除;
 * - 多语句(含分号)拦截。
 */
export interface SqlDecision {
	allowed: boolean;
	mode: "read" | "write" | "blocked";
	reason?: string;
}

const READ_KEYWORDS = new Set(["select", "show", "explain", "describe", "desc", "pragma"]);
const BLOCKED_KEYWORDS = new Set(["drop", "truncate", "alter", "grant", "revoke"]);
const WRITE_KEYWORDS = new Set(["insert", "update", "delete", "replace", "with", "call", "set", "lock", "unlock"]);

export function inspectSql(sql: string, opts: { readOnly?: boolean; confirmWrite?: boolean } = {}): SqlDecision {
	const trimmed = String(sql ?? "")
		.trim()
		.replace(/^\/\*[\s\S]*?\*\//, "")
		.trim();
	if (!trimmed) return { allowed: false, mode: "blocked", reason: "空 SQL" };
	if (/;\s*\S/.test(trimmed.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, ""))) {
		return { allowed: false, mode: "blocked", reason: "禁止多语句:一次只允许一条 SQL" };
	}
	const lower = trimmed.toLowerCase();
	const firstWord = lower.match(/^[a-z]+/)?.[0] ?? "";
	if (BLOCKED_KEYWORDS.has(firstWord)) {
		return { allowed: false, mode: "blocked", reason: `危险语句 ${firstWord.toUpperCase()} 已被规则拦截` };
	}
	const readOnly = opts.readOnly !== false; // 未显式传 readOnly=false 时一律只读
	if (READ_KEYWORDS.has(firstWord)) {
		return { allowed: true, mode: "read" };
	}
	if (WRITE_KEYWORDS.has(firstWord)) {
		if (readOnly) {
			return { allowed: false, mode: "blocked", reason: "只读模式:写操作需显式传入 readOnly=false" };
		}
		if (opts.confirmWrite !== true) {
			return { allowed: false, mode: "blocked", reason: "危险写操作需显式 confirmWrite=true 确认后执行" };
		}
		if ((firstWord === "update" || firstWord === "delete") && !/\bwhere\b/i.test(trimmed)) {
			return { allowed: false, mode: "blocked", reason: `${firstWord.toUpperCase()} 必须带 WHERE 条件,防止全表操作` };
		}
		return { allowed: true, mode: "write" };
	}
	return { allowed: false, mode: "blocked", reason: "无法识别的语句,请使用标准 SQL" };
}

export interface SqlAuditEntry {
	ts: string;
	tenantId: string;
	sql: string;
	mode: "read" | "write";
	readOnly: boolean;
	confirmWrite: boolean;
}

/** 写操作审计:追加 JSONL 到 <dir>/sql-audit.log(不抛错)。 */
export function appendSqlAudit(dir: string, entry: Omit<SqlAuditEntry, "ts">): void {
	try {
		mkdirSync(dir, { recursive: true });
		const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
		appendFileSync(path.join(dir, "sql-audit.log"), line + "\n", "utf8");
	} catch {
		// 审计失败不影响执行
	}
}