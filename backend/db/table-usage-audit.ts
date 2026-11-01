/**
 * SQL 静态检查:把"租户守卫只能拦运行时"往前挪一步,在测试阶段就发现两类问题。
 *
 *   A. 含业务表但整句没有 tenant_id 的**自包含语句**(不含 ${} 插值);
 *      带插值的语句无法静态判断(租户条件常常在被拼进来的片段里),交给运行时的 prepare 守卫。
 *   B. 代码里写死的表名不在 `data.tables` 映射里 —— 这类表同样不会被守卫覆盖。
 *
 * 纯函数 + 文件遍历,便于测试与后续接入 CI。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { inspectTenantScope, SYSTEM_SCOPE_MARK } from "./tenant-guard.js";

export interface SqlFinding {
	file: string;
	kind: "missing-tenant" | "unmapped-table";
	detail: string;
	snippet: string;
}

/** 不参与业务表判定的内部对象(引擎自带 / 虚拟表 / 元数据表)。 */
/** 全局表:本身不是租户数据(guard 里同样是例外),不参与"必须带 tenant_id"的判定。 */
export const GLOBAL_TABLES = ["tenants", "platform_admins"];

export const INTERNAL_TABLES = [
	"sqlite_master", // SQLite 元数据表
	"sqlite_sequence",
	"knowledge_chunks_fts", // FTS5 虚拟表(与 knowledge_chunks 同源)
	"information_schema", // MySQL 元数据(仅出现在探测语句里)
];

const SQL_LIKE = /\b(SELECT|INSERT\s+(OR\s+\w+\s+)?INTO|INSERT\s+IGNORE\s+INTO|UPDATE|DELETE\s+FROM|WITH)\b/i;
// UPDATE 后面排除 "SET"(否则 ON CONFLICT ... DO UPDATE SET 会被误判成表名)
const TABLE_REF = /\b(?:FROM|JOIN|INTO|UPDATE(?!\s+SET\b)|DELETE\s+FROM)\s+`?([A-Za-z_][A-Za-z0-9_]*)`?/gi;

/** 抽出源码里的字符串字面量(模板串与普通串),只保留像 SQL 的。 */
export function extractSqlLiterals(source: string): string[] {
	const out: string[] = [];
	for (const match of source.matchAll(/`([^`]*)`|"([^"]*)"|'([^']*)'/g)) {
		const literal = match[1] ?? match[2] ?? match[3] ?? "";
		if (!SQL_LIKE.test(literal)) continue;
		out.push(literal);
	}
	return out;
}

export interface AuditOptions {
	/** data.tables 映射(键=逻辑表名,值=实际物理表名) */
	tables: Record<string, string>;
	file?: string;
	internalTables?: string[];
}

/** 检查一段源码文本,返回发现的问题。 */
export function auditSqlSource(source: string, options: AuditOptions): SqlFinding[] {
	const file = options.file ?? "<inline>";
	const internal = new Set([...(options.internalTables ?? INTERNAL_TABLES), ...GLOBAL_TABLES].map((t) => t.toLowerCase()));
	const known = new Set([...Object.keys(options.tables), ...Object.values(options.tables)].map((t) => String(t).toLowerCase()));
	const findings: SqlFinding[] = [];
	for (const literal of extractSqlLiterals(source)) {
		const snippet = literal.replace(/\s+/g, " ").trim().slice(0, 140);
		const dynamic = literal.includes("${");
		const systemScoped = literal.includes(SYSTEM_SCOPE_MARK);
		const ddl = /^\s*(CREATE|ALTER|DROP|PRAGMA|TRIGGER)\b/i.test(literal);
		// 逐表判定:与运行时守卫同一套规则(每张业务表都要有自己的租户谓词)
		const scope = inspectTenantScope(literal, options.tables);
		if (!dynamic && !systemScoped && !ddl && scope.uncovered.length > 0) {
			findings.push({
				file,
				kind: "missing-tenant",
				detail: `涉及业务表 ${scope.uncovered.join("/")} 但没有各自的租户谓词(tenant_id)`,
				snippet,
			});
		}
		for (const ref of literal.matchAll(TABLE_REF)) {
			const table = ref[1].toLowerCase();
			if (known.has(table) || internal.has(table)) continue;
			findings.push({ file, kind: "unmapped-table", detail: `表名 ${ref[1]} 不在 data.tables 映射里`, snippet });
		}
	}
	return findings;
}

/** 递归收集待检查的源码文件(跳过依赖、测试与声明文件)。 */
export function collectSourceFiles(roots: string[]): string[] {
	const files: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir)) {
			if (entry === "node_modules" || entry.startsWith(".")) continue;
			const full = path.join(dir, entry);
			if (statSync(full).isDirectory()) walk(full);
			else if (/\.(ts|mts)$/.test(entry) && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts")) files.push(full);
		}
	};
	for (const root of roots) walk(root);
	return files;
}

/** 扫描多个文件并汇总问题(同一条问题只报一次)。 */
export function auditSourceFiles(files: string[], options: AuditOptions): SqlFinding[] {
	const seen = new Set<string>();
	const findings: SqlFinding[] = [];
	for (const file of files) {
		for (const finding of auditSqlSource(readFileSync(file, "utf8"), { ...options, file })) {
			const key = `${finding.file}|${finding.kind}|${finding.detail}|${finding.snippet}`;
			if (seen.has(key)) continue;
			seen.add(key);
			findings.push(finding);
		}
	}
	return findings;
}
