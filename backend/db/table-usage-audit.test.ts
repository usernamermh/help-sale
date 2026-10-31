import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../env.js";
import { auditSourceFiles, auditSqlSource, collectSourceFiles } from "./table-usage-audit.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("SQL 静态检查器本身", () => {
	const tables = { tenants: "tenants", customers: "customers", next_step_tasks: "next_step_tasks" };

	it("自包含语句缺 tenant_id → 报缺失", () => {
		const findings = auditSqlSource('db.prepare("UPDATE next_step_tasks SET status = ? WHERE id = ?")', { tables, file: "x.ts" });
		expect(findings.map((f) => f.kind)).toEqual(["missing-tenant"]);
	});

	it("带 tenant_id 的语句不报", () => {
		expect(auditSqlSource('db.prepare("SELECT * FROM customers WHERE tenant_id = ?")', { tables })).toEqual([]);
	});

	it("带插值的语句交给运行时守卫:静态检查不误报", () => {
		const source = 'const where = ["tenant_id = ?"];\ndb.prepare(`SELECT COUNT(*) FROM customers WHERE ${where.join(" AND ")}`)';
		expect(auditSqlSource(source, { tables })).toEqual([]);
	});

	it("标记 /* system */ 的系统级语句放行", () => {
		expect(auditSqlSource('db.prepare("/* system */ DELETE FROM customers")', { tables })).toEqual([]);
	});

	it("写死了不在映射里的表名 → 报未纳管", () => {
		const findings = auditSqlSource('db.prepare("SELECT * FROM secret_table WHERE tenant_id = ?")', { tables, file: "x.ts" });
		expect(findings.map((f) => f.kind)).toEqual(["unmapped-table"]);
		expect(findings[0].detail).toContain("secret_table");
	});

	it("引擎自带的内部表(sqlite_master / FTS 虚拟表)不算未纳管", () => {
		expect(auditSqlSource('db.prepare("SELECT name FROM sqlite_master WHERE type = ?")', { tables })).toEqual([]);
		expect(auditSqlSource('db.prepare("SELECT * FROM knowledge_chunks_fts WHERE tenant_id = ?")', { tables })).toEqual([]);
	});
});

describe("仓库实况:代码里的 SQL 全部合规", () => {
	it("没有缺 tenant_id 的自包含语句,也没有未纳管的表名", () => {
		const files = collectSourceFiles([
			path.join(repoRoot, "backend"),
			path.join(repoRoot, "3party"),
			path.join(repoRoot, "tools"),
			path.join(repoRoot, "tools_system"),
		]);
		const findings = auditSourceFiles(files, { tables: config.tables });
		const describe = findings.map((f) => `[${f.kind}] ${path.relative(repoRoot, f.file)} — ${f.detail}\n      ${f.snippet}`).join("\n");
		expect(findings, `发现 ${findings.length} 条:\n${describe}`).toEqual([]);
	});
});