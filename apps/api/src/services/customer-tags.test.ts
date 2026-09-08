import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../db/database.js";
import { requireTenant, upsertCustomer } from "../repositories/customers.js";
import { listCustomerTags } from "../repositories/customer-tags.js";
import { extractTagsFromAnalysis, refreshCustomerTags } from "./customer-tags.js";

let db: DatabaseSync;
let customerId: string;

beforeEach(() => {
	db = openDatabase(":memory:");
	requireTenant(db, "t1", "演示租户");
	customerId = upsertCustomer(db, { tenantId: "t1", key: "c_001" }).id;
});

afterEach(() => db.close());

describe("extractTagsFromAnalysis", () => {
	it("从意图与信号确定性抽取标签", () => {
		const tags = extractTagsFromAnalysis({
			intent: "价格异议(含竞品对比)",
			signals: [{ kind: "budget" }, { kind: "competitor" }, { kind: "buying_signal" }],
		});
		expect(tags).toContain("价格敏感");
		expect(tags).toContain("竞品对比");
		expect(tags).toContain("高意向");
	});

	it("空输入返回空", () => {
		expect(extractTagsFromAnalysis({ intent: "", signals: [] })).toEqual([]);
	});
});

describe("refreshCustomerTags", () => {
	it("聚合标签且权重累加(不同分析来源计次)", () => {
		const base = { tenantId: "t1", customerId, signals: [{ kind: "budget" }] };
		refreshCustomerTags(db, { ...base, analysisId: "an1", intent: "价格异议" });
		refreshCustomerTags(db, { ...base, analysisId: "an2", intent: "价格异议" });
		const tags = listCustomerTags(db, "t1", customerId);
		const price = tags.find((t) => t.tag === "价格敏感");
		expect(price?.weight).toBe(2);
		expect(tags[0].tag).toBe("价格敏感"); // weight desc 排序
	});

	it("跨租户隔离", () => {
		requireTenant(db, "t2", "另一租户");
		const other = upsertCustomer(db, { tenantId: "t2", key: "c_9" });
		refreshCustomerTags(db, { tenantId: "t1", customerId, analysisId: "an1", intent: "价格异议", signals: [] });
		expect(listCustomerTags(db, "t2", other.id)).toHaveLength(0);
	});
});