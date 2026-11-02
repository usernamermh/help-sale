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
	const text = stripLiterals(maskSql(sql)).toLowerCase();
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

	// 加固检查:注释/字符串绕过、敏感表列、恒真与 OR 扩范围、UNION/子查询、逐表覆盖、INSERT 取值(读写都过)
	const maskedSql = maskSql(trimmed);
	const safety = sqlSafetyViolation(maskedSql, trimmed, opts);
	if (safety) return blocked(safety);

	const readOnly = opts.readOnly !== false;
	if (READ_KEYWORDS.has(main)) {
		// 业务表必须带租户占位符
		const tenantIssue = tenantViolation(cleaned, opts);
		if (tenantIssue) return blocked(tenantIssue);
				const bound = bindTenantSafe(trimmed, values, opts.tenantId);
		if ("error" in bound) return blocked(bound.error);
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
		if ((main === "update" || main === "delete") && !/\bwhere\b/i.test(maskSql(stripLiterals(body)))) {
			return blocked(`${main.toUpperCase()} 必须带 WHERE 条件,防止全表操作`);
		}
		if (main === "update" || main === "delete") {
			for (const [pattern, label] of TAUTOLOGY_PATTERNS) {
				if (pattern.test(maskSql(stripLiterals(body)).toLowerCase())) return blocked(`拒绝恒真条件:${label}`);
			}
		}
		const tenantIssue = tenantViolation(cleaned, opts);
		if (tenantIssue) return blocked(tenantIssue);
				const bound = bindTenantSafe(trimmed, values, opts.tenantId);
		if ("error" in bound) return blocked(bound.error);
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
/* ===== 加固:注释/字符串绕过、读语句恒真、逐表覆盖、敏感表列、INSERT 取值 ===== */

import { inspectTenantScope } from "../db/tenant-guard.js";

/** 永远不许被 SQL 工具读到的表(账号、密钥、平台管理员)。 */
const DENY_TABLES = ["tenant_secrets", "tenant_config", "users", "platform_admins", "tenants"];
/** 永远不许出现的列(口令摘要)。 */
const DENY_COLUMNS = ["password_hash"];

/** 恒真/越权比较:读语句同样要拦(OR 1=1 / OR true / OR tenant_id <> :tenantId)。 */
const READ_TAUTOLOGY_PATTERNS: Array<[RegExp, string]> = [
	[/\bor\s+(1\s*=\s*1|0\s*=\s*0|\btrue\b)/i, "OR 1=1 / OR true 这类恒真条件"],
	[/\bor\s+(?:[a-z_][a-z0-9_]*\.)?tenant_id\s*(<>|!=)/i, "OR tenant_id <> :tenantId 这类跨租户条件"],
	[/\bwhere\s+(1\s*=\s*1|0\s*=\s*0|\btrue\b)\s*(or|;|$)/i, "WHERE 1=1 / true 这类恒真条件"],
];

/**
 * 把注释与字符串字面量的内容替换成空格(反引号标识符保留),**长度不变**,便于按位置对齐。
 * 这样"藏在注释/字符串里的 tenant_id 或 WHERE"不会被当成真的租户过滤。
 */
export function maskSql(sql: string): string {
	const text = String(sql ?? "");
	const out = text.split("");
	const blank = (from: number, to: number): void => {
		for (let i = from; i < to; i++) if (out[i] !== "\n") out[i] = " ";
	};
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		const next = text[i + 1];
		if (ch === "/" && next === "*") {
			const end = text.indexOf("*/", i + 2);
			const stop = end < 0 ? text.length : end + 2;
			blank(i, stop);
			i = stop;
			continue;
		}
		if ((ch === "-" && next === "-") || ch === "#") {
			const end = text.indexOf("\n", i + (ch === "#" ? 1 : 2));
			const stop = end < 0 ? text.length : end;
			blank(i, stop);
			i = stop;
			continue;
		}
		if (ch === "'" || ch === '"') {
			const quote = ch;
			let j = i + 1;
			while (j < text.length) {
				if (text[j] === "\\") { j += 2; continue; }
				if (text[j] === quote) {
					if (text[j + 1] === quote) { j += 2; continue; }
					break;
				}
				j++;
			}
			blank(i, Math.min(j + 1, text.length));
			i = j + 1;
			continue;
		}
		i++;
	}
	return out.join("");
}

/** 统计记号出现次数:用于"注释/字符串里的占位符不作数"。 */
function countOf(text: string, token: string): number {
	return text.split(token).length - 1;
}

/**
 * 加固后的统一检查。raw 是原句,masked 是把注释/字符串抹掉后的等长句子。
 * 返回非空 = 拒绝执行(附原因)。
 */
export function sqlSafetyViolation(masked: string, raw: string, opts: SqlGuardOptions): string | undefined {
	const lower = masked.toLowerCase();

	// 1) 租户条件不许藏在注释或字符串里
	if (countOf(String(raw).toLowerCase(), "tenant_id") !== countOf(lower, "tenant_id")) {
		return "tenant_id 不允许出现在注释或字符串里(那不算租户过滤)";
	}
	if (countOf(String(raw), ":tenantId") !== countOf(masked, ":tenantId")) {
		return ":tenantId 占位符不允许写在注释或字符串里";
	}

	// 2) 敏感表 / 敏感列一律拒绝
	for (const table of DENY_TABLES) {
		if (new RegExp("(^|[^a-z0-9_])" + table + "([^a-z0-9_]|$)").test(lower)) {
			return "SQL 工具不允许访问 " + table + "(账号/密钥/平台数据不在业务查询范围)";
		}
	}
	for (const column of DENY_COLUMNS) {
		if (new RegExp("(^|[^a-z0-9_])" + column + "([^a-z0-9_]|$)").test(lower)) {
			return "SQL 工具不允许访问 " + column + " 列";
		}
	}

	// 3) 恒真/越权比较:读语句同样拦
	for (const [pattern, label] of READ_TAUTOLOGY_PATTERNS) {
		if (pattern.test(lower)) return "拒绝执行:" + label;
	}

	// 4) 逐表覆盖:每张业务表都要有自己的 :tenantId(或经同租户等值 JOIN 挂到已锚定的表)
	const mapping: Record<string, string> = {};
	for (const table of opts.tenantTables) mapping[table] = table;
	const scope = inspectTenantScope(masked, mapping);
	// 3a) SHOW 一律拒绝:会暴露库结构、连接与其它租户正在执行的语句
	if (/^\s*show\b/i.test(masked.trim())) {
		return "SQL 工具不允许 SHOW(需要表结构请查 information_schema 白名单)";
	}

	// 3a2) SQLite 下双引号是标识符,被 maskSql 当字符串抹掉会漏掉表名检查:直接拒绝这种写法
	if (opts.dialect === "sqlite" && /"[A-Za-z_][A-Za-z0-9_]*"/.test(String(raw))) {
		return "SQLite 下请不要用双引号包表名/列名(会绕过表名检查),用裸名字或反引号";
	}
	// 3b) 结构收窄:涉及业务表时禁止 OR 扩范围 / UNION / 子查询 —— 正则在布尔表达式上判不完整,直接收窄形态
	if (scope.tables.length > 0) {
		if (/\bor\b/.test(lower)) return "涉及业务表时不允许 OR:租户条件必须写成与其它条件并列的 AND";
		if (/\b(union|intersect|except)\b/.test(lower)) return "涉及业务表时不允许 UNION/INTERSECT/EXCEPT";
		if (/\bfrom\s*\(/.test(lower) || /\bin\s*\(\s*select\b/.test(lower)) return "涉及业务表时不允许子查询(FROM (SELECT …) / IN (SELECT …))";
	}

	if (scope.uncovered.length > 0) {
		return "语句涉及业务表(" + scope.uncovered.join(", ") + "),每张表都要有自己的租户过滤(别名.tenant_id = :tenantId,或用 a.tenant_id = b.tenant_id 连到已过滤的表)";
	}

	// 5) INSERT:tenant_id 的取值必须是 :tenantId
	if (/^\s*insert\b/i.test(lower) && /\btenant_id\b/.test(lower) && !/values\s*\([^)]*:tenantid/i.test(lower)) {
		return "INSERT 的 tenant_id 必须写成 :tenantId 占位符(由工具注入当前租户)";
	}
	return undefined;
}

/**
 * 绑定占位符(P0-1 修复):只在**真正的**占位符上替换 —— 字符串/注释里的 ? 和 :tenantId 不参与,
 * 并且要求 values 数量与真正的 ? 数量一致,避免参数与占位符错位导致"租户值绑到别的列"。
 */
export function bindTenantSafe(sql: string, values: unknown[], tenantId: string): { sql: string; values: unknown[] } | { error: string } {
	const text = String(sql ?? "");
	const masked = maskSql(text);
	const tokens: Array<{ index: number; len: number; kind: "tenant" | "q" }> = [];
	for (let i = 0; i < masked.length; i++) {
		if (masked.startsWith(":tenantId", i)) { tokens.push({ index: i, len: 9, kind: "tenant" }); i += 8; continue; }
		if (masked[i] === "?") tokens.push({ index: i, len: 1, kind: "q" });
	}
	const realQuestions = tokens.filter((t) => t.kind === "q").length;
	const bound = Array.isArray(values) ? [...values] : [];
	if (realQuestions !== bound.length) {
		return { error: `参数个数与占位符不匹配:SQL 里真正有 ${realQuestions} 个 ?,传了 ${bound.length} 个值(字符串/注释里的 ? 不算占位符)` };
	}
	if (tokens.some((t) => t.kind === "tenant") && !tenantId) return { error: "缺少当前租户,无法注入 :tenantId" };
	const queue = [...bound];
	const ordered = tokens.map((t) => ({ ...t, value: t.kind === "q" ? queue.shift() : tenantId }));
	let out = text;
	for (const t of [...ordered].sort((a, b) => b.index - a.index)) {
		out = out.slice(0, t.index) + "?" + out.slice(t.index + t.len);
	}
	return { sql: out, values: ordered.map((t) => t.value) };
}

/**
 * 结果层第二道防线:逐行核对 tenant_id,跨租户的行直接丢弃;密钥类列一律不出。
 * (策略层管"能不能执行",这里管"返回了什么")
 */
const SENSITIVE_COLUMN_NAMES = new Set(["password_hash", "password", "api_key", "apikey", "secret", "token", "pat", "value"]);

export interface SanitizeResult {
	rows: unknown[];
	/** 被丢掉的跨租户行数(>0 说明有异常,调用方应告警) */
	crossTenant: number;
	/** 被剔除的敏感列名 */
	strippedColumns: string[];
}

export function sanitizeRows(rows: unknown[], tenantId: string): SanitizeResult {
	const stripped = new Set<string>();
	let crossTenant = 0;
	const kept: unknown[] = [];
	for (const row of rows) {
		if (!row || typeof row !== "object") { kept.push(row); continue; }
		const record = row as Record<string, unknown>;
		const rowTenant = record.tenant_id ?? record.tenantId;
		if (rowTenant !== undefined && String(rowTenant) !== tenantId) { crossTenant += 1; continue; }
		const out: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(record)) {
			if (SENSITIVE_COLUMN_NAMES.has(key.toLowerCase())) { stripped.add(key); continue; }
			out[key] = value;
		}
		kept.push(out);
	}
	return { rows: kept, crossTenant, strippedColumns: [...stripped] };
}
