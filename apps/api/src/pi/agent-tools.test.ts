import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../db/database.js";
import { requireTenant, upsertCustomer } from "../repositories/customers.js";
import { createSalesAgentTools } from "./agent-tools.js";
import type { SessionStore } from "./sessions.js";

let db: DatabaseSync;
const stubStore = {
	createConversation: async () => {
		throw new Error("not used");
	},
	openConversation: async () => {
		throw new Error("not used");
	},
	close: async () => undefined,
} as unknown as SessionStore;

beforeEach(() => {
	db = openDatabase(":memory:");
	requireTenant(db, "t1", "演示租户");
});

afterEach(() => db.close());

describe("list_customers", () => {
	it("返回 Markdown 表格与结构化明细", async () => {
		upsertCustomer(db, { tenantId: "t1", key: "c_001", name: "王总", phone: "13700000001", stage: "洽谈中" });
		upsertCustomer(db, { tenantId: "t1", key: "c_002", name: "陈静", phone: "13700000002", stage: "成交" });
		const tools = await createSalesAgentTools({ db, tenantId: "t1", store: stubStore });
		const tool = tools.find((t) => t.name === "list_customers");
		expect(tool).toBeDefined();
		const out = (await tool!.execute({} as never, { limit: 50 })) as { content: Array<{ text: string }>; details: { customers: unknown[] } };
		const text = out.content.map((c) => c.text).join("");
		expect(text).toContain("| 客户标识 |");
		expect(text).toContain("| --- |");
		expect(text).toContain("王总");
		expect(out.details.customers).toHaveLength(2);
	});

	it("无客户时如实返回", async () => {
		const tools = await createSalesAgentTools({ db, tenantId: "t1", store: stubStore });
		const tool = tools.find((t) => t.name === "list_customers")!;
		const out = (await tool.execute({} as never, {})) as { content: Array<{ text: string }> };
		expect(out.content.map((c) => c.text).join("")).toContain("暂无客户档案");
	});
});