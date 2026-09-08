import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { fauxProvider, fauxToolCall, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { openDatabase } from "../db/database.js";
import { requireTenant } from "../repositories/customers.js";
import { seedVehicles } from "../services/seed.js";
import { openSessionStore, tmpDataDir, cleanupDataDir, type SessionStore } from "./sessions.js";
import { runVehicleMatch } from "./vehicle-advisor.js";

let db: DatabaseSync;
let store: SessionStore;
let dir: string;

beforeEach(() => {
	db = openDatabase(":memory:");
	requireTenant(db, "t1", "演示租户");
	seedVehicles(db, ["t1"]);
	dir = tmpDataDir("vehicle");
	store = openSessionStore(dir);
});

afterEach(async () => {
	await store.close();
	db.close();
	cleanupDataDir(dir);
});

describe("runVehicleMatch", () => {
	it("faux 驱动:检索车型后输出结构化优选方案", async () => {
		const fa = fauxProvider();
		fa.setResponses([
			fauxAssistantMessage([fauxToolCall("vehicle_query", { budgetMin: 15, budgetMax: 30, seats: 5 })]),
			fauxAssistantMessage([
				fauxToolCall("emit_vehicle_plan", {
					profile: "预算 15-30 万,5 座,商务兼家用",
					recommendations: [
						{ brand: "比亚迪", series: "汉", modelName: "汉EV 冠军版", priceText: "19.98-25.98 万", energyType: "纯电", bodyType: "轿车", seats: 5, fitScore: 90, reason: "商务舒适且预算匹配" },
					],
					keyDifferences: ["汉EV 纯电与宋PLUS 插混价位相近"],
					suggestedReply: "根据您的预算和用途,建议先看这两款…",
					nextSteps: ["约试驾", "出配置单"],
				}),
			]),
		]);
		const streamFn: StreamFn = async (model, context, options) => fa.provider.stream(model as never, context, options);

		const result = await runVehicleMatch(
			{ db, tenantId: "t1", store, streamFn },
			{ requirementsText: "客户预算 20 万左右,5 座,主要用于商务接待和通勤", customerKey: "c_car" },
		);

		expect(result.conversationId).toBeTruthy();
		expect(result.details?.profile).toContain("15-30");
		expect(result.details?.recommendations[0].series).toBe("汉");
		expect(result.details?.nextSteps).toContain("约试驾");
		expect(result.messages.some((m) => (m as { role: string }).role === "toolResult")).toBe(true);
	});

	it("检索结果真实来自车型库", async () => {
		const fa = fauxProvider();
		fa.setResponses([
			fauxAssistantMessage([fauxToolCall("vehicle_query", { budgetMin: 25, budgetMax: 35, seats: 5 })]),
			fauxAssistantMessage([
				fauxToolCall("emit_vehicle_plan", {
					profile: "25-35 万 5 座",
					recommendations: [{ brand: "特斯拉", series: "Model Y", modelName: "Model Y 后驱版", priceText: "24.99-27.99 万", energyType: "纯电", bodyType: "SUV", seats: 5, fitScore: 95, reason: "智能驾驶强" }],
					keyDifferences: [],
					suggestedReply: "推荐 Model Y",
					nextSteps: ["约试驾"],
				}),
			]),
		]);
		const streamFn: StreamFn = async (model, context, options) => fa.provider.stream(model as never, context, options);

		const result = await runVehicleMatch({ db, tenantId: "t1", store, streamFn }, { requirementsText: "25-35 万 SUV" });
		const searchResult = result.messages.find((m) => (m as { role: string }).role === "toolResult") as {
			details?: { vehicles?: Array<{ brand: string; series: string }> };
		} | undefined;
		expect(searchResult?.details?.vehicles?.some((v) => v.series === "Model Y")).toBe(true);
	});
});