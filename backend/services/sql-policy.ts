import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

/**
 * SQL 工具的执行策略(语句级防线)。
 *
 *   1) 默认只读;写操作要 readOnly=false + confirmWrite=true 双确认;
 *   2) 黑名单:DDL/权限/运维类语句一律拒绝(含 config 里追加的 extraBlockedKeywords);
 *   3) 危险函数:LOAD_FILE / INTO OUTFILE / SLEEP / BENCHMARK 等直接拒绝;
 *   4) 多语句、MySQL 可执行注释(/*!..*\/)一律拒绝 —— 后者会被 MySQL 当作语句执行,是最常见的绕过手段;
 *   5) WITH ... DELETE/UPDATE 这类语句按"主语句"判定(首词是 WITH,但真正改写数据的是后面那句);
 *   6) UPDATE/DELETE 必须带 WHERE,且拒绝恒真条件(1=1 / true / 'a'='a' …);
 *   7) PRAGMA 只放行"查询型"白名单(table_info 之类),带 `=` 的赋值式 PRAGMA 一律拒绝;
 *   8) 业务表强制租户隔离:语句里必须用 :tenantId 占位符,由工具注入当前租户(禁止写死租户 id);
 *   9) 读语句自动补 LIMIT(上限来自配置),结果再按行数截断。
 */

export interface SqlDecision {
	allowed: boolean;
	mode: "read" | "write" | "blocked";
	reason?: string;
}

export interface SqlGuardOptions {
	readOnly?: boolean;
	confirmWrite?: boolean;
	/** 配置里追加拦截的关键字(tools.sql.extraBlockedKeywords) */
	extraBlockedKeywords?: string[];
	/** 单次最多返回多少行(tools.sql.maxRows),读语句会自动补 LIMIT */
	maxRows: number;
	/** 当前租户(注入到 :tenantId) */
	tenantId: string;
	/** 需要强制租户隔离的表名(小写) */
	tenantTables: string[];
	/** 当前方言:MySQL 不支持 PRAGMA */
	dialect: "sqlite" | "mysql";
}

export interface SqlGuardResult extends SqlDecision {
	/** 规整后的 SQL(可能追加了 LIMIT、:tenantId 已换成 ?) */
	sql: string;
	/** 规整后要绑定的参数(按 ? 出现顺序) */
	values: unknown[];
	/** 结果行数上限 */
	maxRows: number;
}

const READ_KEYWORDS = new Set(["select", "show", "explain", "describe", "desc", "pragma"]);
/** DDL / 权限 / 运维类:一律拒绝 */
const BLOCKED_KEYWORDS = new Set([
	"drop", "truncate", "alter", "create", "rename", "grant", "revoke",
	"attach", "detach", "vacuum", "reindex", "analyze",
	"shutdown", "kill", "flush", "reset", "install", "uninstall",
	"lock", "unlock", "handler", "load", "call", "set",
]);
const WRITE_KEYWORDS = new Set(["insert", "update", "delete", "replace", "with", "merge", "upsert"]);
const DML_KEYWORDS = new Set(["select", "insert", "update", "delete", "replace"]);

/** SQLite 里只允许"只看不改"的 pragma;带 `=` 的赋值式一律拒绝 */
const PRAGMA_ALLOWLIST = new Set([
	"table_info", "table_xinfo", "index_list", "index_info", "index_xinfo",
	"foreign_key_list", "database_list", "compile_options",
]);

/** 危险函数/写法(小写匹配) */
const DANGEROUS_PATTERNS: Array<[RegExp, string]> = [
	[/\bload_file\s*\(/, "LOAD_FILE(读取服务器本地文件)"],
	[/\binto\s+(out|dump)file\b/, "INTO OUTFILE/DUMPFILE(写服务器文件)"],
	[/\bload\s+data\b/, "LOAD DATA(导入文件)"],
	[/\bbenchmark\s*\(/, "BENCHMARK(消耗 CPU)"],
	[/\bsleep\s*\(/, "SLEEP(拖住连接)"],
	[/\bpg_read_file\s*\(/, "pg_read_file(读取服务器文件)"],
];

/** 恒真条件(只用于 UPDATE/DELETE 的守卫) */
const TAUTOLOGY_PATTERNS: Array<[RegExp, string]> = [
	[/\bwhere\s+(1\s*=\s*1|0\s*=\s*0|true)\b/, "WHERE 1=1 / true 这类恒真条件"],
	[/\bwhere\s+('\s*'\s*=\s*'\s*'|"\s*"\s*=\s*"\s*")/, "WHERE 空串比较这类恒真条件"],
	[/\bwhere\s+1\s*(;|$)/, "WHERE 1 这类恒真条件"],
	[/\bor\s+(1\s*=\s*1|0\s*=\s*0|true)\b/, "OR 1=1 这类恒真条件"],
];

const stripLeadingComments = (sql: string): string => {
	let text = String(sql ?? "");
	for (;;) {
		const next = text.replace(/^\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/)/, "");
		if (next === text) return text.trim();
		text = next;
	}
};

/** 去掉字符串字面量,便于做"关键字/占位符"扫描(字符串里的符号不参与判定) */
function stripLiterals(sql: string): string {
	return sql.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');
}

/**
 * 找主语句关键字:首词是 WITH 时,声明部分之后的第一个 DML 关键字才是真正改数据的那句。
 * 只扫描括号深度 0 的词,CTE 内部的 SELECT 不算。
 */
export function mainKeywordOf(sql: string): string {
	const text = stripLiterals(sql).toLowerCase();
	const first = text.match(/^[a-z]+/)?.[0] ?? "";
	if (first !== "with") return first;
	let depth = 0;
	const re = /[a-z_]+|[()]/g;
	let m: RegExpExecArray | null;
	let seenGroup = false;
	while ((m = re.exec(text))) {
		const token = m[0];
		if (token === "(") { depth++; continue; }
		if (token === ")") { depth--; if (depth === 0) seenGroup = true; continue; }
		if (depth === 0 && seenGroup && DML_KEYWORDS.has(token)) return token;
	}
	return "with";
}

/** 去掉 CTE 声明部分,返回主语句文本(用于 WHERE 判定等) */
export function stripCte(sql: string): string {
	const text = sql;
	if ((stripLiterals(text).toLowerCase().match(/^[a-z]+/)?.[0] ?? "") === "with") {
		const lower = stripLiterals(text).toLowerCase();
		let depth = 0;
		const re = /[a-z_]+|[()]/g;
		let m: RegExpExecArray | null;
		let seenGroup = false;
		while ((m = re.exec(lower))) {
			if (m[0] === "(") { depth++; continue; }
			if (m[0] === ")") { depth--; if (depth === 0) seenGroup = true; continue; }
			if (depth === 0 && seenGroup && DML_KEYWORDS.has(m[0])) return text.slice(m.index);
		}
	}
	return text;
}

/** 兼容旧调用:只做"允不允许"的判定 */
export function inspectSql(sql: string, opts: { readOnly?: boolean; confirmWrite?: boolean } = {}): SqlDecision {
	const result = guardSql(sql, [], {
		readOnly: opts.readOnly,
		confirmWrite: opts.confirmWrite,
		maxRows: Number.MAX_SAFE_INTEGER,
		tenantId: "",
		tenantTables: [],
		dialect: "sqlite",
	});
	return { allowed: result.allowed, mode: result.mode, reason: result.reason };
}

/** 把 :tenantId 占位符换成 ?,并保持与已有 ? 的顺序一致 */
function bindTenant(sql: string, values: unknown[], tenantId: string): { sql: string; values: unknown[] } {
	const parts = sql.split(/(:tenantId|\?)/i);
	const outValues: unknown[] = [];
	let existing = 0;
	let next = "";
	for (const part of parts) {
		if (part === "?") {
			outValues.push(values[existing]);
			existing++;
			next += "?";
			continue;
		}
		if (/^:tenantId$/i.test(part)) {
			outValues.push(tenantId);
			next += "?";
			continue;
		}
		next += part;
	}
	return { sql: next, values: outValues };
}

/** 完整的语句守卫:返回"能不能执行 + 实际要执行的 SQL/参数/行数上限" */
/** 租户守卫:业务表必须用 :tenantId 占位符,且不允许把 tenant_id 写死 */
function tenantViolation(cleanedSql: string, opts: SqlGuardOptions): string | undefined {
	const referenced = referencedTenantTables(cleanedSql, opts.tenantTables);
	if (referenced.length === 0) return undefined;
	if (/\btenant_id\s*(=|<>|!=|like)\s*['"\d]/i.test(cleanedSql)) {
		return "禁止把 tenant_id 写成字面量,请统一用 :tenantId 占位符(由工具注入当前租户)";
	}
	if (!/:tenantId/i.test(cleanedSql)) {
		return `语句涉及业务表(${referenced.join(", ")}),必须用 :tenantId 占位符做租户过滤(由工具注入当前租户,不要写死 tenant_id)`;
	}
	return undefined;
}
export function guardSql(sql: string, values: unknown[], opts: SqlGuardOptions): SqlGuardResult {
	const blocked = (reason: string): SqlGuardResult => ({ allowed: false, mode: "blocked", reason, sql, values, maxRows: opts.maxRows });
	const raw = String(sql ?? "");
	const trimmed = stripLeadingComments(raw);
	if (!trimmed) return blocked("空 SQL");
	// MySQL 可执行注释会被服务端当语句执行,是最常见的绕过方式
	if (/\/\*!/.test(trimmed)) return blocked("含 MySQL 可执行注释(/*! … */),拒绝执行");

	const cleaned = stripLiterals(trimmed);
	if (/;\s*\S/.test(cleaned.replace(/--[^\n]*/g, ""))) return blocked("禁止多语句:一次只允许一条 SQL");

	const main = mainKeywordOf(trimmed);
	const firstWord = cleaned.toLowerCase().match(/^[a-z]+/)?.[0] ?? "";
	const extra = new Set((opts.extraBlockedKeywords ?? []).map((k) => String(k).trim().toLowerCase()).filter(Boolean));

	if (BLOCKED_KEYWORDS.has(firstWord) || BLOCKED_KEYWORDS.has(main)) {
		const word = BLOCKED_KEYWORDS.has(main) ? main : firstWord;
		return blocked(`危险语句 ${word.toUpperCase()} 已被规则拦截(tools.sql 黑名单)`);
	}
	// 配置追加的关键字:整句扫描(如 union / into / for update),命中即拒
	if (extra.size > 0) {
		const lowerAll = cleaned.toLowerCase();
		for (const keyword of extra) {
			const escaped = keyword.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&");
			if (new RegExp(`(^|[^a-z0-9_])${escaped}([^a-z0-9_]|$)`).test(lowerAll)) return blocked(`语句包含被禁用的关键字 ${keyword}(tools.sql.extraBlockedKeywords)`);
		}
	}
	for (const [pattern, label] of DANGEROUS_PATTERNS) {
		if (pattern.test(cleaned.toLowerCase())) return blocked(`包含危险写法:${label}`);
	}

	// PRAGMA:只放行查询型白名单,禁止赋值式
	if (main === "pragma" || firstWord === "pragma") {
		if (opts.dialect === "mysql") return blocked("MySQL 下不支持 PRAGMA,请改查 information_schema");
		const body = cleaned.toLowerCase().replace(/^pragma\s+/, "");
		const name = body.match(/^([a-z_]+)/)?.[1] ?? "";
		if (/=/.test(body)) return blocked("禁止赋值式 PRAGMA(如 PRAGMA writable_schema=ON)");
		if (!PRAGMA_ALLOWLIST.has(name)) return blocked(`PRAGMA ${name || "(空)"} 不在白名单内(只允许 table_info/index_list 等查询型 pragma)`);
		return { allowed: true, mode: "read", sql: trimmed, values: [...values], maxRows: opts.maxRows };
	}

	const readOnly = opts.readOnly !== false;
	if (READ_KEYWORDS.has(main)) {
		// 业务表必须带租户占位符
		const tenantIssue = tenantViolation(cleaned, opts);
		if (tenantIssue) return blocked(tenantIssue);
		const bound = bindTenant(trimmed, values, opts.tenantId);
		// 读语句补 LIMIT(仅 SELECT;SHOW/EXPLAIN/DESCRIBE 不合法)
		let finalSql = bound.sql.replace(/;\s*$/, "");
		if (main === "select" && !/\blimit\b/i.test(cleaned) && !/\bfor\s+update\b/i.test(cleaned) && !/\binto\b/i.test(cleaned)) {
			finalSql = `${finalSql}\nLIMIT ${Math.max(1, Math.trunc(opts.maxRows))}`;
		}
		return { allowed: true, mode: "read", sql: finalSql, values: bound.values, maxRows: opts.maxRows };
	}

	if (WRITE_KEYWORDS.has(main)) {
		if (readOnly) return blocked("只读模式:写操作需显式传入 readOnly=false");
		if (opts.confirmWrite !== true) return blocked("危险写操作需显式 confirmWrite=true 确认后执行");
		const body = stripCte(trimmed);
		if ((main === "update" || main === "delete") && !/\bwhere\b/i.test(stripLiterals(body))) {
			return blocked(`${main.toUpperCase()} 必须带 WHERE 条件,防止全表操作`);
		}
		if (main === "update" || main === "delete") {
			for (const [pattern, label] of TAUTOLOGY_PATTERNS) {
				if (pattern.test(stripLiterals(body).toLowerCase())) return blocked(`拒绝恒真条件:${label}`);
			}
		}
		const tenantIssue = tenantViolation(cleaned, opts);
		if (tenantIssue) return blocked(tenantIssue);
		const bound = bindTenant(trimmed, values, opts.tenantId);
		return { allowed: true, mode: "write", sql: bound.sql, values: bound.values, maxRows: opts.maxRows };
	}

	return blocked("无法识别的语句,请使用标准 SQL");
}

/** 语句里引用了哪些需要租户隔离的表 */
function referencedTenantTables(cleanedSql: string, tenantTables: string[]): string[] {
	const lower = cleanedSql.toLowerCase();
	const hits: string[] = [];
	for (const table of tenantTables) {
		const name = String(table).toLowerCase();
		if (!name) continue;
		if (new RegExp(`(^|[^a-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9_]|$)`).test(lower)) hits.push(name);
	}
	return [...new Set(hits)];
}

export interface SqlAuditEntry {
	ts: string;
	tenantId: string;
	sql: string;
	mode: "read" | "write";
	readOnly: boolean;
	confirmWrite: boolean;
	ok: boolean;
	rows?: number;
	error?: string;
}

/** 审计:读/写、成功/失败都追加 JSONL 到 <dir>/sql-audit.log(不抛错) */
export function appendSqlAudit(dir: string, entry: Omit<SqlAuditEntry, "ts">): void {
	try {
		mkdirSync(dir, { recursive: true });
		const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
		appendFileSync(path.join(dir, "sql-audit.log"), line + "\n", "utf8");
	} catch {
		// 审计失败不影响执行
	}
}