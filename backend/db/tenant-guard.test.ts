import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { inspectAndGuard, inspectTenantScope, resetTenantGuardWarnings, SYSTEM_SCOPE_MARK, withTenantGuard } from "./tenant-guard.js";

const TABLES = {
	tenants: "tenants",
	customers: "customers",
	agent_threads: "agent_threads",
	agent_thread_messages: "agent_thread_messages",
};

describe("租户隔离检查", () => {
	it("业务表语句缺 tenant_id 谓词 → 判违规;带了就通过", () => {
		expect(inspectTenantScope("SELECT * FROM customers", TABLES).hasTenantPredicate).toBe(false);
		expect(inspectTenantScope("SELECT * FROM customers", TABLES).tables).toEqual(["customers"]);
		expect(inspectTenantScope("SELECT * FROM customers WHERE tenant_id = ?", TABLES).hasTenantPredicate).toBe(true);
		expect(inspectTenantScope("SELECT c.name FROM customers c WHERE c.tenant_id = ?", TABLES).hasTenantPredicate).toBe(true);
	});

	it("只查租户表本身不算业务表访问", () => {
		const scope = inspectTenantScope("SELECT id FROM tenants ORDER BY id", TABLES);
		expect(scope.tables).toEqual([]);
	});

	it("系统级语句可以用标记显式豁免", () => {
		const scope = inspectTenantScope(`${SYSTEM_SCOPE_MARK} DELETE FROM agent_thread_messages`, TABLES);
		expect(scope.systemScoped).toBe(true);
	});

	it("enforce 模式直接拦下,warn 模式只告警不拦", () => {
		resetTenantGuardWarnings();
		const violations: string[] = [];
		expect(() => inspectAndGuard("SELECT * FROM customers", { tables: TABLES, mode: "off" })).not.toThrow();
		expect(() => inspectAndGuard("SELECT * FROM customers", { tables: TABLES, mode: "enforce" })).toThrow(/租户隔离拦截/);
		expect(() => inspectAndGuard("SELECT * FROM customers", { tables: TABLES, mode: "warn", onViolation: (info) => violations.push(info.table) })).not.toThrow();
		expect(violations).toEqual(["customers"]);
	});

	it("withTenantGuard 包在 prepare 上:坏语句抛错,好语句照常执行", () => {
		const db = withTenantGuard(new DatabaseSync(":memory:"), { tables: TABLES, mode: "enforce" });
		db.exec("CREATE TABLE customers (id TEXT PRIMARY KEY, tenant_id TEXT, name TEXT)");
		db.prepare("INSERT INTO customers (id, tenant_id, name) VALUES (?,?,?)").run("c1", "t1", "张三");
		const rows = db.prepare("SELECT name FROM customers WHERE tenant_id = ?").all("t1") as Array<{ name: string }>;
		expect(rows[0].name).toBe("张三");
		// 漏写租户条件的那类语句,进不来
		expect(() => db.prepare("SELECT id, name FROM customers")).toThrow(/租户隔离拦截/);
		// 带系统标记的跨租户语句放行
		const all = db.prepare(`${SYSTEM_SCOPE_MARK} SELECT COUNT(*) AS c FROM customers`).get() as { c: number };
		expect(Number(all.c)).toBe(1);
		db.close();
	});
});