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
describe("SQL 加固:绕过样例都拦得住", () => {
	const opts = (): any => ({
		readOnly: false,
		confirmWrite: true,
		maxRows: 50,
		tenantId: "t_demo",
		tenantTables: ["customers", "conversations", "next_step_tasks"],
		dialect: "mysql",
	});
	const blocked = (sql: string): string => {
		const res = guardSql(sql, [], opts());
		return res.allowed ? "" : String(res.reason ?? "");
	};

	it("注释里的租户过滤不算数", () => {
		expect(blocked("SELECT * FROM customers /* WHERE tenant_id = :tenantId */")).toContain("注释");
	});

	it("占位符写在字符串里不算数", () => {
		expect(blocked("SELECT * FROM customers WHERE name = ':tenantId'")).not.toBe("");
	});

	it("读语句的恒真条件同样拦", () => {
		expect(blocked("SELECT * FROM customers WHERE tenant_id = :tenantId OR 1=1")).toContain("恒真");
		expect(blocked("SELECT * FROM customers WHERE tenant_id = :tenantId OR true")).toContain("恒真");
	});

	it("OR tenant_id <> :tenantId 这类跨租户条件拦下", () => {
		expect(blocked("SELECT * FROM customers WHERE tenant_id = :tenantId OR tenant_id <> :tenantId")).toContain("跨租户");
	});

	it("JOIN 只在一边写租户条件:拦下;两边都写:放行", () => {
		expect(blocked("SELECT c.name FROM customers c JOIN conversations v ON v.customer_id = c.id WHERE c.tenant_id = :tenantId")).toContain("conversations");
		expect(blocked("SELECT c.name FROM customers c JOIN conversations v ON v.customer_id = c.id WHERE c.tenant_id = :tenantId AND v.tenant_id = :tenantId")).toBe("");
	});

	it("INSERT 的 tenant_id 必须是 :tenantId,不能写字面量", () => {
		expect(blocked("INSERT INTO customers (id, tenant_id, name) VALUES ('c1', 't_demo', 'x')")).not.toBe("");
		expect(blocked("INSERT INTO customers (id, tenant_id, name) VALUES (?, ?, ?)")).toContain(":tenantId");
		expect(guardSql("INSERT INTO customers (id, tenant_id, name) VALUES (?, :tenantId, ?)", ["c1", "x"], opts()).allowed).toBe(true);
	});

	it("账号/密钥/平台数据不在业务查询范围", () => {
		for (const table of ["users", "tenant_secrets", "tenant_config", "platform_admins"]) {
			expect(blocked(`SELECT * FROM ${table}`)).toContain(table);
		}
		expect(blocked("SELECT password_hash FROM customers")).not.toBe("");
	});
});
describe("SQL 加固第二批:评审给出的绕过样例全部拦住", () => {
	const o = () => ({
		readOnly: false,
		confirmWrite: true,
		maxRows: 200,
		tenantId: "t_current",
		tenantTables: ["customers", "conversations", "tenant_secrets", "users", "platform_admins"],
		dialect: "mysql" as const,
	});
	const denied = (sql: string, values: unknown[] = [], extra: Record<string, unknown> = {}): boolean => {
		const res = guardSql(sql, values, { ...o(), ...extra } as any);
		return res.allowed === false;
	};

	it("P0-1 字符串/注释里的 ? 不吃参数:数量对不上直接拒", () => {
		expect(denied("SELECT * FROM customers WHERE name <> '?' AND tenant_id = :tenantId", ["t_other"], { readOnly: true })).toBe(true);
		expect(denied("INSERT INTO customers (name, tenant_id) VALUES ('?', :tenantId)", ["x"])).toBe(true);
	});

	it("P0-1 正常语句不受影响:值按顺序绑定,租户占位符注入当前租户", () => {
		const res = guardSql("SELECT * FROM customers WHERE tenant_id = :tenantId AND name = ?", ["张三"], { ...o(), readOnly: true } as any);
		expect(res.allowed).toBe(true);
		expect(res.values).toEqual(["t_current", "张三"]);
	});

	it("P0-2 写路径同样过敏感表/恒真/逐表覆盖", () => {
		expect(denied("UPDATE tenant_secrets SET value='x' WHERE tenant_id = :tenantId")).toBe(true);
		expect(denied("UPDATE customers SET name='x' WHERE tenant_id = :tenantId OR 2=2")).toBe(true);
	});

	it("P0-3 读语句的 OR 扩范围一律拒", () => {
		expect(denied("SELECT * FROM customers WHERE tenant_id = :tenantId OR 2=2", [], { readOnly: true })).toBe(true);
		expect(denied("SELECT * FROM customers WHERE tenant_id = :tenantId OR (1=1)", [], { readOnly: true })).toBe(true);
	});

	it("P0-4 UNION 与子查询一律拒", () => {
		expect(denied("SELECT * FROM customers WHERE tenant_id = :tenantId UNION SELECT * FROM customers", [], { readOnly: true })).toBe(true);
		expect(denied("SELECT * FROM customers WHERE tenant_id = :tenantId AND id IN (SELECT id FROM customers)", [], { readOnly: true })).toBe(true);
	});

	it("P0-5 注释不能骗过主语句判定:该走写分支", () => {
		const res = guardSql("WITH c AS (SELECT 1) /* select */ DELETE FROM customers WHERE tenant_id = :tenantId", [], { ...o() } as any);
		expect(res.mode).toBe("write");
		const readonly = guardSql("WITH c AS (SELECT 1) /* select */ DELETE FROM customers WHERE tenant_id = :tenantId", [], { ...o(), readOnly: true } as any);
		expect(readonly.allowed).toBe(false);
	});

	it("P0-6 SHOW 一律拒", () => {
		expect(denied("SHOW PROCESSLIST", [], { readOnly: true })).toBe(true);
		expect(denied("SHOW TABLES", [], { readOnly: true })).toBe(true);
	});

	it("P1 tenants 表不给 SQL 工具枚举", () => {
		expect(denied("SELECT * FROM tenants", [], { readOnly: true })).toBe(true);
	});
});