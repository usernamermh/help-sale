import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../db/database.js";
import { getCustomer, listCustomers, requireTenant, upsertCustomer } from "./customers.js";

let db: DatabaseSync;

beforeEach(() => {
	db = openDatabase(":memory:");
	requireTenant(db, "t1", "演示租户");
});

afterEach(() => db.close());

describe("customers", () => {
	it("upsert 新建客户", () => {
		const row = upsertCustomer(db, { tenantId: "t1", key: "c_001", name: "王经理", company: "苏州智造" });
		expect(row.id).toBeTruthy();
		expect(getCustomer(db, "t1", "c_001")?.company).toBe("苏州智造");
	});

	it("同租户同 key 重复 upsert 不产生新行", () => {
		upsertCustomer(db, { tenantId: "t1", key: "c_001", stage: "A" });
		const again = upsertCustomer(db, { tenantId: "t1", key: "c_001", stage: "B" });
		const rows = db.prepare("SELECT COUNT(*) AS n FROM customers").get() as { n: number };
		expect(rows.n).toBe(1);
		expect(again.stage).toBe("B");
	});

	it("租户隔离:不同租户的同 key 是两条记录", () => {
		requireTenant(db, "t2", "另一租户");
		upsertCustomer(db, { tenantId: "t1", key: "c_001" });
		upsertCustomer(db, { tenantId: "t2", key: "c_001" });
		expect(db.prepare("SELECT COUNT(*) AS n FROM customers").get()).toEqual({ n: 2 });
	});

	it("upsert 支持客户联系方式(phone)更新", () => {
		const first = upsertCustomer(db, { tenantId: "t1", key: "c_ph", name: "王经理", phone: "13700000000" });
		expect(getCustomer(db, "t1", "c_ph")?.phone).toBe("13700000000");
		const again = upsertCustomer(db, { tenantId: "t1", key: "c_ph", name: "王经理", phone: "13800000000" });
		expect(again.phone).toBe("13800000000");
	});


	it("listCustomers 返回客户清单(电话/阶段/最近分析/会话数,按最近分析排序)", () => {
		const a = upsertCustomer(db, { tenantId: "t1", key: "c_a", name: "王总", phone: "13700000001", stage: "洽谈中" });
		const b = upsertCustomer(db, { tenantId: "t1", key: "c_b", name: "李总", phone: "13700000002", stage: "成交" });
		// c_a 有最近分析与会话,应排前面
		requireTenant(db, "t2", "另一租户");
		upsertCustomer(db, { tenantId: "t2", key: "c_x", name: "别家客户" });
		// 直接插入分析与会话(与 analyses 表结构一致)
		db.prepare("INSERT INTO analyses (id, tenant_id, customer_id, conversation_id, intent, summary, signals_json, suggested_reply, next_steps_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
			.run("an-a", "t1", a.id, "conv-a", "价格异议", "s", "[]", "r", "[]", "2026-09-01T08:00:00Z");
		db.prepare("INSERT INTO conversations (id, tenant_id, customer_id, sales_name, channel, message_count) VALUES (?,?,?,?,?,?)")
			.run("conv-a", "t1", a.id, "李销售", "chat", 3);
		const rows = listCustomers(db, "t1", 50);
		expect(rows).toHaveLength(2);
		expect(rows[0].key).toBe("c_a");
		expect(rows[0].name).toBe("王总");
		expect(rows[0].phone).toBe("13700000001");
		expect(rows[0].lastAnalysisAt).toBe("2026-09-01T08:00:00Z");
		expect(rows[0].conversationCount).toBe(1);
		// 跨租户隔离
		expect(listCustomers(db, "t2", 50)).toHaveLength(1);
	});

	it("upsert 支持意向车型列表(listCustomers 可读回)", () => {
		upsertCustomer(db, { tenantId: "t1", key: "c_iv", name: "孙悦", intendedVehicles: ["汉EV 冠军版", "Model Y 后驱版"] });
		const row = getCustomer(db, "t1", "c_iv")!;
		expect(JSON.parse(row.intended_vehicles!)).toEqual(["汉EV 冠军版", "Model Y 后驱版"]);
		const again = upsertCustomer(db, { tenantId: "t1", key: "c_iv", intendedVehicles: [] });
		expect(JSON.parse(again.intended_vehicles!)).toEqual([]);
		const brief = listCustomers(db, "t1", 50).find((c) => c.key === "c_iv");
		expect(brief?.intendedVehicles).toEqual([]);
	});

	it("upsert 支持地区来源与备注字段", () => {
		const row = upsertCustomer(db, { tenantId: "t1", key: "c_region", name: "李雷", region: "苏州", notes: "高意向" });
		expect(row.region).toBe("苏州");
		expect(row.notes).toBe("高意向");
		const again = upsertCustomer(db, { tenantId: "t1", key: "c_region", region: "上海" });
		expect(again.region).toBe("上海");
		expect(again.notes).toBe("高意向");
		const brief = listCustomers(db, "t1", 50).find((c) => c.key === "c_region");
		expect(brief?.region).toBe("上海");
	});
});
