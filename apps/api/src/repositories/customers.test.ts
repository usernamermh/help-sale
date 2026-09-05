import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../db/database.js";
import { getCustomer, requireTenant, upsertCustomer } from "./customers.js";

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
});