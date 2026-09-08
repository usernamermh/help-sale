import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../db/database.js";
import { requireTenant, upsertCustomer } from "./customers.js";
import { upsertConversation } from "./conversations.js";
import {
	listConversationMessages, replaceConversationMessages, toolCacheKey, withToolCache,
} from "./conversation-data.js";

let db: DatabaseSync;

beforeEach(() => {
		db = openDatabase(":memory:");
	requireTenant(db, "t1", "演示租户");
	requireTenant(db, "t2", "另一租户");
});

function seedConversation(db: DatabaseSync, tenantId: string, convId: string): void {
	const customer = upsertCustomer(db, { tenantId, key: convId + "-cust" });
	upsertConversation(db, { id: convId, tenantId, customerId: customer.id, salesName: "李销售" });
}

afterEach(() => db.close());

describe("conversation_messages", () => {
	it("replace 写入原文(时间/角色/内容),重复 replace 幂等替换", () => {
		seedConversation(db, "t1", "conv-1");
		const n1 = replaceConversationMessages(db, "t1", "conv-1", [
			{ speakerRole: "customer", speakerName: "王总", content: "价格多少?", spokenAt: "2026-09-01T08:00:00Z" },
			{ speakerRole: "sales", speakerName: "李销售", content: "您好,预算多少?" },
		]);
		expect(n1).toBe(2);
		let rows = listConversationMessages(db, "t1", "conv-1");
		expect(rows).toHaveLength(2);
		expect(rows[0].speaker_role).toBe("customer");
		expect(rows[0].content).toBe("价格多少?");
		expect(rows[0].spoken_at).toBe("2026-09-01T08:00:00Z");
		expect(rows[1].seq).toBe(2);
		expect(rows[1].spoken_at).toBeTruthy(); // 未提供时自动生成

		seedConversation(db, "t1", "conv-1");
		replaceConversationMessages(db, "t1", "conv-1", [
			{ speakerRole: "sales", speakerName: "李销售", content: "新内容" },
			{ speakerRole: "customer", speakerName: "王总", content: "好的" },
		]);
		rows = listConversationMessages(db, "t1", "conv-1");
		expect(rows).toHaveLength(2);
		expect(rows[0].content).toBe("新内容");
		expect(rows[0].seq).toBe(1);
	});

	it("租户隔离", () => {
		seedConversation(db, "t1", "conv-1");
		replaceConversationMessages(db, "t1", "conv-1", [{ speakerRole: "customer", content: "A" }]);
		seedConversation(db, "t2", "conv-2");
		replaceConversationMessages(db, "t2", "conv-2", [{ speakerRole: "customer", content: "B" }]);
		expect(listConversationMessages(db, "t1", "conv-1")).toHaveLength(1);
		expect(listConversationMessages(db, "t2", "conv-2")).toHaveLength(1);
	});
});

describe("tool_call_cache", () => {
	it("缓存键与参数键序无关", () => {
		expect(toolCacheKey({ query: "价格", limit: 3 })).toBe(toolCacheKey({ limit: 3, query: "价格" }));
		expect(toolCacheKey({ query: "价格" })).not.toBe(toolCacheKey({ query: "预算" }));
	});

	it("withToolCache 命中返回缓存,未命中执行并落库", () => {
		let calls = 0;
		const compute = () => {
			calls++;
			return { content: [{ type: "text", text: "结果A" }], details: { q: "价格" } };
		};
		const first = withToolCache(db, "t1", "knowledge_search", { query: "价格", limit: 3 }, compute);
		const second = withToolCache(db, "t1", "knowledge_search", { limit: 3, query: "价格" }, compute);
		expect(first).toEqual(second);
		expect(calls).toBe(1);
		const row = db.prepare("SELECT result_json,last_used_at FROM tool_call_cache WHERE tenant_id='t1' AND tool_name='knowledge_search'").get() as { result_json: string; last_used_at: string | null };
		expect(row).toBeTruthy();
		expect(JSON.parse(row.result_json)).toEqual(first);
	});

	it("不同租户缓存相互独立", () => {
		let calls = 0;
		const compute = () => {
			calls++;
			return { content: [{ type: "text", text: "x" }] };
		};
		withToolCache(db, "t1", "vehicle_query", { keyword: "SUV" }, compute);
		withToolCache(db, "t2", "vehicle_query", { keyword: "SUV" }, compute);
		expect(calls).toBe(2);
	});
});