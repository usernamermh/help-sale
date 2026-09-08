import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../db/database.js";
import { requireTenant, upsertCustomer } from "../repositories/customers.js";
import { insertKnowledgeDocument } from "../repositories/knowledge.js";
import { createCopilotTools } from "./tools.js";

let db: DatabaseSync;
let tools: Awaited<ReturnType<typeof createCopilotTools>>;

beforeEach(async () => {
	db = openDatabase(":memory:");
	requireTenant(db, "t1", "演示租户");
	insertKnowledgeDocument(db, {
		tenantId: "t1",
		title: "价格政策",
		chunks: ["标准版 999 元/年,旗舰版 1999 元/年,年付送一个月"],
	});
	tools = await createCopilotTools({ db, tenantId: "t1" });
});

afterEach(() => db.close());

const byName = (name: string) => tools.find((t) => t.name === name)!;

describe("copilot tools", () => {
	it("knowledge_search 命中知识库", async () => {
		const result = await byName("knowledge_search").execute("call-1", { query: "旗舰版" } as never, undefined as never, undefined as never);
		expect((result.details as { hits: unknown[] }).hits).toHaveLength(1);
		expect(result.content[0].type).toBe("text");
	});

	it("customer_query 按 key 查询档案", async () => {
		const result = await byName("customer_query").execute("call-2", { view: "profile", customerKey: "c_001" } as never, undefined as never, undefined as never);
		expect(result.details.key).toBe("c_001");
	});

	it("emit_analysis 返回结构化 details 且 terminate", async () => {
		const result = await byName("emit_analysis").execute("call-3", {
			intent: "价格异议",
			summary: "客户觉得贵",
			signals: [{ kind: "budget", quote: "超出预算", note: "预算有限" }],
			suggestedReply: "先共情再讲 ROI",
			nextSteps: ["发案例", "跟进"],
		} as never, undefined as never, undefined as never);
		expect(result.terminate).toBe(true);
		expect((result.details as { intent: string }).intent).toBe("价格异议");
	});
});