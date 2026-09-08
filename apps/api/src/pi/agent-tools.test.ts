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

describe("customer_query", () => {
	it("view=profile 支持按姓名解析真实 key", async () => {
		upsertCustomer(db, { tenantId: "t1", key: "c_cj", name: "陈静", phone: "13700000000", company: "盛源科技" });
		const tools = await createSalesAgentTools({ db, tenantId: "t1", store: stubStore });
		const tool = tools.find((t) => t.name === "customer_query")!;
		const out = (await tool.execute("g1", { view: "profile", customerKey: "陈静" })) as { content: Array<{ text: string }>; details: { key: string; phone: string | null } };
		const text = out.content.map((c) => c.text).join("");
		expect(out.details.key).toBe("c_cj");
		expect(text).toContain("13700000000");
	});
	it("view=list 返回 Markdown 表格与结构化明细", async () => {
		upsertCustomer(db, { tenantId: "t1", key: "c_001", name: "王总", phone: "13700000001", stage: "洽谈中" });
		upsertCustomer(db, { tenantId: "t1", key: "c_002", name: "陈静", phone: "13700000002", stage: "成交" });
		const tools = await createSalesAgentTools({ db, tenantId: "t1", store: stubStore });
		const tool = tools.find((t) => t.name === "customer_query");
		expect(tool).toBeDefined();
		const out = (await tool!.execute({} as never, { view: "list", limit: 50 })) as { content: Array<{ text: string }>; details: { customers: unknown[] } };
		const text = out.content.map((c) => c.text).join("");
		expect(text).toContain("| 客户标识 |");
		expect(text).toContain("| --- |");
		expect(text).toContain("王总");
		expect(out.details.customers).toHaveLength(2);
	});

	it("view=list 无客户时如实返回", async () => {
		const tools = await createSalesAgentTools({ db, tenantId: "t1", store: stubStore });
		const tool = tools.find((t) => t.name === "customer_query")!;
		const out = (await tool.execute({} as never, { view: "list" })) as { content: Array<{ text: string }> };
		expect(out.content.map((c) => c.text).join("")).toContain("暂无客户档案");
	});

	it("view=list 每页 10 行,支持翻页", async () => {
		for (let i = 1; i <= 12; i++) {
			upsertCustomer(db, { tenantId: "t1", key: "c_page_" + String(i).padStart(2, "0"), name: "客户" + String(i).padStart(2, "0") });
		}
		const tools = await createSalesAgentTools({ db, tenantId: "t1", store: stubStore });
		const tool = tools.find((t) => t.name === "customer_query")!;
		const p1 = (await tool.execute("p1", { view: "list", limit: 100 })) as { content: Array<{ text: string }>; details: { customers: unknown[]; page: number; pageSize: number; totalRows: number; totalPages: number; hasMore: boolean } };
		expect(p1.details.totalRows).toBe(12);
		expect(p1.details.pageSize).toBe(10);
		expect(p1.details.page).toBe(1);
		expect(p1.details.totalPages).toBe(2);
		expect(p1.details.hasMore).toBe(true);
		expect(p1.details.customers).toHaveLength(10);
		expect(p1.content.map((c) => c.text).join("")).toContain("第 1/2 页");
		const p2 = (await tool.execute("p2", { view: "list", page: 2 })) as { details: { customers: unknown[]; page: number; hasMore: boolean } };
		expect(p2.details.customers).toHaveLength(2);
		expect(p2.details.page).toBe(2);
		expect(p2.details.hasMore).toBe(false);
	});
});