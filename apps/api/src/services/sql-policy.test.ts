import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendSqlAudit, inspectSql } from "./sql-policy.js";

describe("inspectSql 权限与危险拦截", () => {
	it("只读语句默认放行(SELECT/SHOW/PRAGMA)", () => {
		expect(inspectSql("SELECT * FROM customers LIMIT 1").mode).toBe("read");
		expect(inspectSql("SELECT * FROM customers LIMIT 1").allowed).toBe(true);
		expect(inspectSql("SHOW TABLES").allowed).toBe(true);
		expect(inspectSql("PRAGMA table_info(customers)").allowed).toBe(true);
	});

	it("写操作默认只读被拦截,并提示需要 readOnly=false", () => {
		const r = inspectSql("UPDATE customers SET phone = '1'");
		expect(r.allowed).toBe(false);
		expect(r.reason).toContain("readOnly=false");
	});

	it("readOnly=false 但未 confirmWrite 时拦截", () => {
		const r = inspectSql("UPDATE customers SET phone = '1'", { readOnly: false, confirmWrite: false });
		expect(r.allowed).toBe(false);
		expect(r.reason).toContain("confirmWrite=true");
	});

	it("危险语句 DROP/TRUNCATE/ALTER 一律拦截", () => {
		for (const sql of ["DROP TABLE customers", "TRUNCATE customers", "ALTER TABLE customers ADD c TEXT", "GRANT ALL ON *.* TO x", "REVOKE ALL ON *.* FROM x"]) {
			const r = inspectSql(sql, { readOnly: false, confirmWrite: true });
			expect(r.allowed).toBe(false);
			expect(r.mode).toBe("blocked");
		}
	});

	it("UPDATE/DELETE 必须带 WHERE,否则拦截", () => {
		expect(inspectSql("UPDATE customers SET phone='1'", { readOnly: false, confirmWrite: true }).allowed).toBe(false);
		expect(inspectSql("DELETE FROM customers", { readOnly: false, confirmWrite: true }).allowed).toBe(false);
		expect(inspectSql("UPDATE customers SET phone='1' WHERE id='x'", { readOnly: false, confirmWrite: true }).allowed).toBe(true);
		expect(inspectSql("DELETE FROM customers WHERE key='c_1'", { readOnly: false, confirmWrite: true }).allowed).toBe(true);
	});

	it("正常的 INSERT 在双重确认后放行,多语句仍拦截", () => {
		const ok = inspectSql("INSERT INTO tasks (id, action) VALUES ('t1', '回访')", { readOnly: false, confirmWrite: true });
		expect(ok.allowed).toBe(true);
		expect(ok.mode).toBe("write");
		const multi = inspectSql("SELECT 1; DROP TABLE x", { readOnly: false, confirmWrite: true });
		expect(multi.allowed).toBe(false);
	});
});

describe("appendSqlAudit", () => {
	let dir: string;
	beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "sql-audit-")); });
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it("写操作审计落盘 JSONL", () => {
		appendSqlAudit(dir, { tenantId: "t1", sql: "UPDATE customers SET phone='1' WHERE id='x'", mode: "write", readOnly: false, confirmWrite: true });
		const lines = fs.readFileSync(path.join(dir, "sql-audit.log"), "utf8").split("\n").filter(Boolean);
		expect(lines).toHaveLength(1);
		const entry = JSON.parse(lines[0]) as { ts: string; tenantId: string; sql: string; mode: string };
		expect(entry.tenantId).toBe("t1");
		expect(entry.sql).toContain("UPDATE");
		expect(entry.ts).toBeTruthy();
	});
});