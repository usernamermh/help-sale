import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../db/database.js";
import { requireTenant, upsertCustomer } from "./customers.js";
import { upsertConversation } from "./conversations.js";
import {
	createDeal, getSalespersonById, getStore, getStoreManager, getStoreOverview,
	listDeals, listSales, listStores, upsertSalesperson, upsertStore,
} from "./store-ops.js";

let db: DatabaseSync;

beforeEach(() => {
	db = openDatabase(":memory:");
	requireTenant(db, "t1", "演示租户");
});

afterEach(() => db.close());

describe("stores", () => {
	it("upsertStore 幂等并按租户隔离", () => {
		const s1 = upsertStore(db, "t1", { name: "旗舰店", address: "苏州园区" });
		expect(s1.id).toBeTruthy();
		const again = upsertStore(db, "t1", { name: "旗舰店", address: "苏州园区新址" });
		expect(again.id).toBe(s1.id);
		expect(again.address).toBe("苏州园区新址");
		expect(listStores(db, "t1")).toHaveLength(1);
		requireTenant(db, "t2", "另一租户");
		expect(listStores(db, "t2")).toHaveLength(0);
	});

	it("upsertSalesperson 关联门店与角色,店长查询正确", () => {
		const store = upsertStore(db, "t1", { name: "旗舰店" });
		const mgr = upsertSalesperson(db, "t1", { storeId: store.id, name: "张店长", phone: "13800000001", role: "manager" });
		expect(mgr.role).toBe("manager");
		const again = upsertSalesperson(db, "t1", { storeId: store.id, name: "张店长", phone: "13800000002" });
		expect(again.id).toBe(mgr.id);
		expect(again.phone).toBe("13800000002");
		const detail = getStoreManager(db, "t1", store.id);
		expect(detail.manager?.id).toBe(mgr.id);
		expect(detail.sales).toHaveLength(1);
		expect(getSalespersonById(db, "t1", mgr.id)?.role).toBe("manager");
		expect(listSales(db, "t1", store.id)).toHaveLength(1);
	});
});

describe("deals", () => {
	it("createDeal 落库并带客户/销售/门店信息读回", () => {
		const store = upsertStore(db, "t1", { name: "旗舰店" });
		const sales = upsertSalesperson(db, "t1", { storeId: store.id, name: "李销售", phone: "13900000000" });
		const customer = upsertCustomer(db, { tenantId: "t1", key: "c_deal", name: "王总", company: "智造科技", phone: "13700000000" });
		const deal = createDeal(db, "t1", { storeId: store.id, salesId: sales.id, customerId: customer.id, amount: 199900, dealedAt: "2026-09-01T08:00:00Z" });
		expect(deal.id).toBeTruthy();
		expect(deal.amount).toBe(199900);
		const rows = listDeals(db, "t1", { storeId: store.id });
		expect(rows).toHaveLength(1);
		expect(rows[0].customerName).toBe("王总");
		expect(rows[0].customerKey).toBe("c_deal");
		expect(rows[0].customerPhone).toBe("13700000000");
		expect(rows[0].salesName).toBe("李销售");
		expect(rows[0].storeName).toBe("旗舰店");
	});

	it("createDeal 固定 id 幂等", () => {
		const customer = upsertCustomer(db, { tenantId: "t1", key: "c_deal2" });
		createDeal(db, "t1", { customerId: customer.id, amount: 100, id: "seed-deal-1" });
		createDeal(db, "t1", { customerId: customer.id, amount: 100, id: "seed-deal-1" });
		expect(listDeals(db, "t1")).toHaveLength(1);
	});

	it("按时间段过滤", () => {
		const customer = upsertCustomer(db, { tenantId: "t1", key: "c_deal3" });
		createDeal(db, "t1", { customerId: customer.id, amount: 1, dealedAt: "2026-08-01T01:00:00Z" });
		createDeal(db, "t1", { customerId: customer.id, amount: 2, dealedAt: "2026-09-01T01:00:00Z" });
		const rows = listDeals(db, "t1", { from: "2026-08-15T00:00:00Z", to: "2026-09-30T00:00:00Z" });
		expect(rows).toHaveLength(1);
		expect(rows[0].amount).toBe(2);
	});
});

describe("getStoreOverview", () => {
	function seedVisits(storeId: string, salesId: string, customerId: string, n: number, fromDays: number): void {
		for (let i = 0; i < n; i++) {
			const day = new Date(Date.now() - (fromDays - i) * 24 * 3600 * 1000);
			const id = `conv-${fromDays}-${i}`;
			db.prepare(
				`INSERT OR IGNORE INTO conversations (id, tenant_id, customer_id, sales_name, sales_id, store_id, channel, message_count, created_at, updated_at)
				 VALUES (?,?,?,?,?,?,?,?,?,?)`,
			).run(id, "t1", customerId, "李销售", salesId, storeId, "chat", 3, day.toISOString(), day.toISOString());
		}
	}

	it("聚合接客/成交/金额/成交率/每日/订单", () => {
		const store = upsertStore(db, "t1", { name: "旗舰店" });
		const sales = upsertSalesperson(db, "t1", { storeId: store.id, name: "李销售" });
		const customer = upsertCustomer(db, { tenantId: "t1", key: "c_ov", name: "王总" });
		seedVisits(store.id, sales.id, customer.id, 3, 3);
		createDeal(db, "t1", { storeId: store.id, salesId: sales.id, customerId: customer.id, amount: 100, dealedAt: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString() });
		createDeal(db, "t1", { storeId: store.id, salesId: sales.id, customerId: customer.id, amount: 250, dealedAt: new Date(Date.now() - 1 * 24 * 3600 * 1000).toISOString() });
		createDeal(db, "t1", { storeId: store.id, salesId: sales.id, customerId: customer.id, amount: 50, dealedAt: new Date(Date.now() - 20 * 24 * 3600 * 1000).toISOString() });

		const from = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
		const to = new Date().toISOString();
		const ov = getStoreOverview(db, "t1", { storeId: store.id, from, to });
		expect(ov.visits).toBe(3);
		expect(ov.deals).toBe(2);
		expect(ov.amount).toBe(350);
		expect(ov.conversionRate).toBeCloseTo(66.7, 0);
		expect(ov.orders).toHaveLength(2);
		expect(ov.orders[0].amount).toBe(250);
		expect(ov.daily.some((d) => d.deals > 0 && d.visits > 0)).toBe(true);
		expect(ov.store).not.toBeNull();
		expect(ov.store!.id).toBe(store.id);
	});

	it("无数据时返回零值", () => {
		const store = upsertStore(db, "t1", { name: "空店" });
		const ov = getStoreOverview(db, "t1", { storeId: store.id });
		expect(ov.visits).toBe(0);
		expect(ov.deals).toBe(0);
		expect(ov.amount).toBe(0);
		expect(ov.conversionRate).toBe(0);
		expect(ov.orders).toEqual([]);
	});
});