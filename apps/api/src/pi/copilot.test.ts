import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { fauxProvider, fauxToolCall, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { openDatabase } from "../db/database.js";
import { requireTenant } from "../repositories/customers.js";
import { insertKnowledgeDocument } from "../repositories/knowledge.js";
import { openSessionStore, tmpDataDir, cleanupDataDir, type SessionStore } from "./sessions.js";
import { runCopilotAnalysis } from "./copilot.js";

let db: DatabaseSync;
let store: SessionStore;
let dir: string;

beforeEach(() => {
	db = openDatabase(":memory:");
	requireTenant(db, "t1", "演示租户");
	insertKnowledgeDocument(db, {
		tenantId: "t1",
		title: "价格政策",
		chunks: ["标准版 999 元/年,旗舰版 1999 元/年,年付送一个月"],
	});
	dir = tmpDataDir("copilot");
	store = openSessionStore(dir);
});

afterEach(async () => {
	await store.close();
	db.close();
	cleanupDataDir(dir);
});

describe("runCopilotAnalysis", () => {
	it("faux 驱动:检索知识库后输出分析并落库会话", async () => {
		const fa = fauxProvider();
		fa.setResponses([
			fauxAssistantMessage([fauxToolCall("knowledge_search", { query: "旗舰版", limit: 3 })]),
			fauxAssistantMessage([
				fauxToolCall("emit_analysis", {
					intent: "价格异议",
					summary: "客户询问旗舰版价格",
					signals: [{ kind: "budget", quote: "预算有限", note: "提到预算" }],
					suggestedReply: "先共情再讲 ROI",
					nextSteps: ["发送价格方案"],
					followupAt: "2026-09-01T10:00:00.000Z",
				}),
			]),
		]);
		const streamFn: StreamFn = async (model, context, options) =>
			fa.provider.stream(model as never, context, options);

		const result = await runCopilotAnalysis(
			{ db, tenantId: "t1", store, streamFn },
			{ transcript: "客户:旗舰版多少钱?太贵了" },
		);

		expect(result.conversationId).toBeTruthy();
		expect(result.details?.intent).toBe("价格异议");
		expect(result.details?.nextSteps).toContain("发送价格方案");
		expect(result.messages.some((m) => (m as { role: string }).role === "toolResult")).toBe(true);
	});

	it("知识库检索被实际调用且返回内容", async () => {
		const fa = fauxProvider();
		fa.setResponses([
			fauxAssistantMessage([fauxToolCall("knowledge_search", { query: "旗舰版", limit: 3 })]),
			fauxAssistantMessage([
				fauxToolCall("emit_analysis", {
					intent: "需求确认",
					summary: "客户感兴趣",
					signals: [],
					suggestedReply: "好的",
					nextSteps: ["约演示"],
				}),
			]),
		]);
		const streamFn: StreamFn = async (model, context, options) =>
			fa.provider.stream(model as never, context, options);

		const result = await runCopilotAnalysis(
			{ db, tenantId: "t1", store, streamFn },
			{ transcript: "客户:介绍一下旗舰版" },
		);

		const toolResults = result.messages.filter((m) => (m as { role: string }).role === "toolResult");
		expect(toolResults.length).toBeGreaterThanOrEqual(2);
		const searchResult = toolResults[0] as { content: { type: string; text: string }[] };
		expect(searchResult.content[0].text).toContain("价格政策");
	});
});