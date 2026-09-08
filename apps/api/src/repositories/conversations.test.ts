import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../db/database.js";
import { requireTenant, upsertCustomer } from "./customers.js";
import { getConversation, listConversations, upsertConversation } from "./conversations.js";

let db: DatabaseSync;

beforeEach(() => {
	db = openDatabase(":memory:");
	requireTenant(db, "t1", "演示租户");
});

afterEach(() => db.close());

describe("conversations", () => {
	it("upsert 新建并更新消息数与销售名,带客户信息", () => {
		upsertConversation(db, { id: "conv-1", tenantId: "t1", customerId: upsertCustomer(db, { tenantId: "t1", key: "c_001", name: "王经理" }).id, salesName: "小李", messageCount: 3 });
		const row = getConversation(db, "t1", "conv-1")!;
		expect(row.salesName).toBe("小李");
		expect(row.customerName).toBe("王经理");
		expect(row.customerKey).toBe("c_001");

		upsertConversation(db, { id: "conv-1", tenantId: "t1", messageCount: 8, salesName: "小李" });
		expect(getConversation(db, "t1", "conv-1")!.messageCount).toBe(8);
	});

	it("列表按更新时间倒序且租户隔离", () => {
		upsertConversation(db, { id: "c1", tenantId: "t1", salesName: "甲" });
		upsertConversation(db, { id: "c2", tenantId: "t1", salesName: "乙" });
		requireTenant(db, "t2", "另一租户");
		upsertConversation(db, { id: "c3", tenantId: "t2", salesName: "丙" });
		expect(listConversations(db, "t1", 20).map((r) => r.id).sort()).toEqual(["c1", "c2"]);
		expect(listConversations(db, "t2", 20)).toHaveLength(1);
	});
});