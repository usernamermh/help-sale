import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../db/database.js";
import { requireTenant, upsertCustomer } from "../repositories/customers.js";
import { upsertStore, upsertSalesperson } from "../repositories/store-ops.js";
import { createTask } from "../repositories/tasks.js";
import { getStorePerformance, getSalesWorkbench } from "./performance.js";

let db: DatabaseSync;
beforeEach(() => {
	db = openDatabase(":memory:");
	requireTenant(db, "t1", "演示租户");
});
afterEach(() => db.close());

describe("销售绩效与工作台", () => {
	it("门店绩效:成交量/额/试驾转化/回访完成率与排名", () => {
		const store = upsertStore(db, "t1", { name: "旗舰店" });
		const s1 = upsertSalesperson(db, "t1", { storeId: store.id, name: "销售甲", phone: "1", role: "sales" });
		const s2 = upsertSalesperson(db, "t1", { storeId: store.id, name: "销售乙", phone: "2", role: "sales" });
		const c1 = upsertCustomer(db, { tenantId: "t1", key: "c_1", name: "王总" });
		const c2 = upsertCustomer(db, { tenantId: "t1", key: "c_2", name: "李总" });

		db.prepare(
			"INSERT INTO deals (id, tenant_id, store_id, sales_id, customer_id, amount, discount_amount, status, dealed_at) VALUES (?,?,?,?,?,?,?, 'closed', ?)",
		).run("d1", "t1", store.id, s1.id, c1.id, 280000, 5000, "2026-09-01T00:00:00Z");
		db.prepare(
			"INSERT INTO deals (id, tenant_id, store_id, sales_id, customer_id, amount, status, dealed_at) VALUES (?,?,?,?,?,?, 'closed', ?)",
		).run("d2", "t1", store.id, s2.id, c2.id, 150000, "2026-09-02T00:00:00Z");

		db.prepare(
			"INSERT INTO test_drives (id, tenant_id, customer_id, sales_id, store_id, status) VALUES (?,?,?,?,?, 'completed')",
		).run("td1", "t1", c1.id, s1.id, store.id);

		const t1 = createTask(db, { tenantId: "t1", customerId: c1.id, salesId: s1.id, action: "回访", dueAt: "2026-09-01T00:00:00Z" });
		createTask(db, { tenantId: "t1", customerId: c1.id, salesId: s1.id, action: "待办" });
		db.prepare("UPDATE next_step_tasks SET status='done', completed_at=? WHERE id=?").run("2026-09-02T00:00:00Z", t1.id);

		const perf = getStorePerformance(db, "t1", store.id);
		expect(perf).toHaveLength(2);
		const p1 = perf.find((p) => p.salesId === s1.id)!;
		expect(p1.deals).toBe(1);
		expect(p1.dealAmount).toBe(280000);
		expect(p1.testDriveConvert).toBe(1);
		expect(p1.followupDone).toBe(1);
		expect(p1.followupTotal).toBe(2);
		expect(p1.followupRate).toBe(0.5);
		expect(p1.rank).toBe(1);
		const p2 = perf.find((p) => p.salesId === s2.id)!;
		expect(p2.rank).toBe(2);
	});

	it("销售工作台:待办/逾期/活跃客户/月度成交", () => {
		const store = upsertStore(db, "t1", { name: "旗舰店" });
		const s = upsertSalesperson(db, "t1", { storeId: store.id, name: "销售甲", role: "sales" });
		const c = upsertCustomer(db, { tenantId: "t1", key: "c_1", name: "王总" });
		db.prepare(
			"INSERT INTO conversations (id, tenant_id, customer_id, sales_id, sales_name, message_count, updated_at) VALUES (?,?,?,?,?,?,?)",
		).run("cv1", "t1", c.id, s.id, "销售甲", 1, new Date().toISOString());
		createTask(db, { tenantId: "t1", customerId: c.id, salesId: s.id, action: "逾期跟进", dueAt: "2020-01-01T00:00:00Z" });
		db.prepare(
			"INSERT INTO deals (id, tenant_id, store_id, sales_id, customer_id, amount, status, dealed_at) VALUES (?,?,?,?,?,?, 'closed', ?)",
		).run("d1", "t1", store.id, s.id, c.id, 200000, new Date().toISOString());

		const wb = getSalesWorkbench(db, "t1", s.id)!;
		expect(wb.salesName).toBe("销售甲");
		expect(wb.overdueTasks).toHaveLength(1);
		expect(wb.activeCustomers).toHaveLength(1);
		expect(wb.monthDeals).toBe(1);
		expect(wb.monthAmount).toBe(200000);
	});
});