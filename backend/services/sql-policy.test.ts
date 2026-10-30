import { describe, expect, it } from "vitest";
import { guardSql, mainKeywordOf } from "./sql-policy.js";

/**
 * SQL 守卫的行为约定(对应 README「SQL 执行策略」一节)。
 * 只测策略层:不连数据库。
 */

const base = {
	maxRows: 200,
	tenantId: "t_demo",
	tenantTables: ["customers", "conversations", "next_step_tasks"],
	dialect: "sqlite" as "sqlite" | "mysql",
};

const guard = (sql: string, opts: Partial<typeof base> & { readOnly?: boolean; confirmWrite?: boolean; extraBlockedKeywords?: string[]; values?: unknown[] } = {}) =>
	guardSql(sql, opts.values ?? [], { ...base, ...opts });

describe("SQL 守卫:主语句判定(WITH)", () => {
	it("WITH ... SELECT 仍是只读,并补 LIMIT", () => {
		const r = guard("WITH x AS (SELECT id FROM customers WHERE tenant_id = :tenantId) SELECT * FROM x");
		expect(r.allowed).toBe(true);
		expect(r.mode).toBe("read");
		expect(r.sql).toContain("LIMIT 200");
		expect(mainKeywordOf("WITH x AS (SELECT 1) SELECT 2")).toBe("select");
	});

	it("WITH ... DELETE 没有 WHERE 也要拦住(不能只看首词 WITH)", () => {
		const r = guard("WITH x AS (SELECT id FROM customers WHERE tenant_id = :tenantId) DELETE FROM customers", { readOnly: false, confirmWrite: true });
		expect(r.allowed).toBe(false);
		expect(r.reason).toContain("必须带 WHERE");
		expect(mainKeywordOf("WITH x AS (SELECT 1) DELETE FROM customers")).toBe("delete");
	});
});

describe("SQL 守卫:PRAGMA", () => {
	it("查询型 pragma 放行,赋值式与不在白名单的拒绝", () => {
		expect(guard("PRAGMA table_info(customers)").allowed).toBe(true);
		const assignment = guard("PRAGMA writable_schema=ON");
		expect(assignment.allowed).toBe(false);
		expect(assignment.reason).toContain("赋值式 PRAGMA");
		expect(guard("PRAGMA journal_mode").allowed).toBe(false);
		const mysqlPragma = guard("PRAGMA table_info(customers)", { dialect: "mysql" } as never);
		expect(mysqlPragma.allowed).toBe(false);
		expect(mysqlPragma.reason).toContain("information_schema");
	});
});

describe("SQL 守卫:租户隔离", () => {
	it("业务表必须用 :tenantId,并注入当前租户", () => {
		const missing = guard("SELECT count(*) FROM customers");
		expect(missing.allowed).toBe(false);
		expect(missing.reason).toContain(":tenantId");

		const r = guard("SELECT * FROM customers WHERE tenant_id = :tenantId AND `key` = ?", { values: ["c_001"] });
		expect(r.allowed).toBe(true);
		expect(r.sql).toContain("tenant_id = ?");
		expect(r.values).toEqual(["t_demo", "c_001"]);
	});

	it("禁止写死 tenant_id", () => {
		const r = guard("SELECT * FROM customers WHERE tenant_id = 't_other'");
		expect(r.allowed).toBe(false);
		expect(r.reason).toContain("字面量");
	});

	it("不涉及业务表的语句不需要 :tenantId", () => {
		expect(guard("SELECT 1 AS ok").allowed).toBe(true);
	});

	it("写操作同样注入租户,且参数顺序与 ? 一致", () => {
		const r = guard("UPDATE next_step_tasks SET status = ? WHERE tenant_id = :tenantId AND id = ?", {
			readOnly: false,
			confirmWrite: true,
			values: ["done", "task-1"],
		});
		expect(r.allowed).toBe(true);
		expect(r.mode).toBe("write");
		expect(r.values).toEqual(["done", "t_demo", "task-1"]);
	});
});

describe("SQL 守卫:LIMIT", () => {
	it("只有 SELECT 且没写 LIMIT 时才自动补;已有 LIMIT 不动", () => {
		expect(guard("SELECT 1").sql).toContain("LIMIT 200");
		expect(guard("SELECT 1 LIMIT 5").sql).not.toContain("LIMIT 200");
		expect(guard("SELECT 1").maxRows).toBe(200);
	});
});

describe("SQL 守卫:危险语句与写法", () => {
	it("DDL / 权限 / 运维语句一律拒绝", () => {
		for (const sql of ["DROP TABLE customers", "ALTER TABLE customers ADD COLUMN x INT", "CREATE TABLE t (id INT)", "GRANT ALL ON *.* TO x", "ATTACH DATABASE 'x.db' AS y", "SET GLOBAL x = 1", "CALL p()", "VACUUM"]) {
			expect(guard(sql, { readOnly: false, confirmWrite: true }).allowed, sql).toBe(false);
		}
	});

	it("危险函数与导出写法拒绝", () => {
		for (const sql of ["SELECT load_file('/etc/passwd')", "SELECT * FROM customers INTO OUTFILE '/tmp/x'", "SELECT SLEEP(10)", "SELECT BENCHMARK(1000, 1)"]) {
			expect(guard(sql).allowed, sql).toBe(false);
		}
	});

	it("多语句与 MySQL 可执行注释拒绝", () => {
		expect(guard("SELECT 1; SELECT 2").allowed).toBe(false);
		expect(guard("SELECT 1; SELECT 2", { readOnly: false, confirmWrite: true }).allowed).toBe(false);
		expect(guard("/*!50000 SELECT 1 */").allowed).toBe(false);
	});

	it("配置里追加的关键字同样拦截", () => {
		const r = guard("SELECT * FROM customers WHERE tenant_id = :tenantId UNION SELECT 1", { extraBlockedKeywords: ["union"] });
		expect(r.allowed).toBe(false);
	});
});

describe("SQL 守卫:恒真条件", () => {
	it("UPDATE/DELETE 的 WHERE 1=1 / true / OR 1=1 一律拒绝", () => {
		const cases = [
			"DELETE FROM customers WHERE 1=1",
			"UPDATE customers SET name = ? WHERE true",
			"DELETE FROM customers WHERE tenant_id = :tenantId OR 1=1",
			"DELETE FROM customers WHERE 1",
		];
		for (const sql of cases) {
			const r = guard(sql, { readOnly: false, confirmWrite: true, values: ["x"] });
			expect(r.allowed, sql).toBe(false);
		}
	});

	it("正常的 WHERE 仍然放行", () => {
		const r = guard("DELETE FROM customers WHERE tenant_id = :tenantId AND id = ?", { readOnly: false, confirmWrite: true, values: ["c1"] });
		expect(r.allowed).toBe(true);
	});

	it("只读语句不受恒真条件限制(WHERE 1=1 查全部是分析常用写法)", () => {
		expect(guard("SELECT count(*) FROM customers WHERE tenant_id = :tenantId AND 1=1").allowed).toBe(true);
	});
});