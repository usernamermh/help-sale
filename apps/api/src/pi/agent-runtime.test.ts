import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import path from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { fauxProvider, fauxToolCall, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { openDatabase } from "../db/database.js";
import { requireTenant } from "../repositories/customers.js";
import { getAgentPlanByRun } from "../repositories/agent-plans.js";
import { listKanbanCards } from "../services/kanban-store.js";
import { AgentCancelledError, runMultiAgentFlow, runPlanPhase, runSalesAgent, stripChartsForHistory, stripMarkdownTables, verifyPlan, runSalesAgentWithPlan } from "./agent-runtime.js";
import { openSessionStore, tmpDataDir, cleanupDataDir, type SessionStore } from "./sessions.js";

let db: DatabaseSync;
let store: SessionStore;
let dir: string;

beforeEach(() => {
	db = openDatabase(":memory:");
	requireTenant(db, "t1", "演示租户");
	dir = tmpDataDir("agent-runtime");
	store = openSessionStore(dir);
});
afterEach(async () => {
	await store.close();
	db.close();
	cleanupDataDir(dir);
});

describe("表格防幻觉", () => {
	it("stripMarkdownTables:剔除模型自造表格,保留代码块内内容", () => {
		const stripped = stripMarkdownTables("总结如下\n| 姓名 | 电话 |\n| --- | --- |\n| 陈静 | 15835137159 |\n共 1 位。");
		expect(stripped).not.toContain("| 姓名");
		expect(stripped).not.toContain("15835137159");
		expect(stripped).toContain("总结如下");
		expect(stripped).toContain("共 1 位");
		const fenced = stripMarkdownTables("```\n| a | b |\n```\n保留");
		expect(fenced).toContain("| a | b |");
		expect(fenced).toContain("保留");
	});

	it("stripChartsForHistory:历史中的 echarts 块替换为占位,模型不再看到图表 JSON", () => {
		const out = stripChartsForHistory("结论\n```echarts\n{\"a\":1}\n```\n结尾");
		expect(out).toContain("[图表]");
		expect(out).not.toContain("echarts");
		const arr = stripChartsForHistory([{ type: "text", text: "x\n```echarts\n{1}\n```\n" }]);
		expect(JSON.stringify(arr)).toContain("[图表]");
		expect(JSON.stringify(arr)).not.toContain("echarts");
	});

	it("多次查表时只保留最后一次工具返回的表格", async () => {
		const fa = fauxProvider();
		fa.setResponses([
			fauxAssistantMessage([
				fauxToolCall("table_generate", { title: "A", rows: [{ name: "汉EV", price: "25万" }], chartType: "table" }),
			]),
			fauxAssistantMessage([
				fauxToolCall("table_generate", { title: "B", rows: [{ brand: "Model Y", price: "28万" }], chartType: "table" }),
			]),
			fauxAssistantMessage([
				fauxToolCall("emit_final", { answer: "汇总:\n| A | B |\n| --- | --- |\n| 1 | 2 |\n" }),
			]),
		]);
		const streamFn: StreamFn = async (model, context, options) => fa.provider.stream(model as never, context, options);
		const result = await runSalesAgent({ db, tenantId: "t1", store, streamFn }, { goal: "两次生成车型表" });
		expect(result.final?.answer).toContain("| brand | price |");
		expect(result.final?.answer).toContain("Model Y");
		expect(result.final?.answer).not.toContain("| name | price |");
		expect(result.final?.answer).not.toContain("汉EV");
	});

	it("无工具表格时,保留模型自己输出的表格", async () => {
		const fa = fauxProvider();
		fa.setResponses([
			fauxAssistantMessage([
				fauxToolCall("emit_final", {
					answer: "客户清单:\n| 姓名 | 电话 |\n| --- | --- |\n| 陈静 | 15835137159 |\n共 1 位。",
				}),
			]),
		]);
		const streamFn: StreamFn = async (model, context, options) => fa.provider.stream(model as never, context, options);
		const result = await runSalesAgent({ db, tenantId: "t1", store, streamFn }, { goal: "查客户清单" });
		expect(result.final?.answer).toContain("| 陈静");
		expect(result.final?.answer).toContain("15835137159");
	});

	it("工具已返回表格时,剔除模型重复表格并追加工具原文", async () => {
		const fa = fauxProvider();
		fa.setResponses([
			fauxAssistantMessage([
				fauxToolCall("table_generate", {
					title: "车型",
					rows: [{ name: "汉EV", price: "25万" }, { name: "Model Y", price: "28万" }],
					chartType: "table",
				}),
			]),
			fauxAssistantMessage([
				fauxToolCall("emit_final", {
					answer: "汇总:\n| A | B |\n| --- | --- |\n| 1 | 2 |\n",
				}),
			]),
		]);
		const streamFn: StreamFn = async (model, context, options) => fa.provider.stream(model as never, context, options);
		const result = await runSalesAgent({ db, tenantId: "t1", store, streamFn }, { goal: "生成车型表" });
		expect(result.final?.answer).not.toContain("| A | B |");
		expect(result.final?.answer).toContain("| name | price |");
		expect(result.final?.answer).toContain("汉EV");
	});
});

describe("图表保真", () => {
	it("工具返回的 ECharts 图表块原样追加到最终答复", async () => {
		const fa = fauxProvider();
		fa.setResponses([
			fauxAssistantMessage([
				fauxToolCall("chart_generate", {
					type: "bar",
					title: "销售漏斗",
					categories: ["新进店", "已联系", "试驾", "成交"],
					series: [{ name: "客户数量", data: [52, 4, 1, 2] }],
				}),
			]),
			fauxAssistantMessage([fauxToolCall("emit_final", { answer: "销售漏斗图已生成完毕。" })]),
		]);
		const streamFn: StreamFn = async (model, context, options) => fa.provider.stream(model as never, context, options);
		const result = await runSalesAgent({ db, tenantId: "t1", store, streamFn }, { goal: "生成销售漏斗图" });
		expect(result.final?.answer).toContain("```echarts");
		expect(result.final?.answer).toContain("销售漏斗");
		expect(result.final?.answer).toContain("[52,4,1,2]");
	});
});

describe("规划-执行-验证(P-E-V)", () => {
	it("runPlanPhase:规划阶段输出 emit_plan 步骤", async () => {
		const fa = fauxProvider();
		fa.setResponses([
			fauxAssistantMessage([
				fauxToolCall("emit_plan", {
					summary: "三步完成客户跟进分析",
					steps: [
						{ step: "查客户档案", tool: "customer_query", purpose: "拿到客户资料" },
						{ step: "查话术库", tool: "knowledge_search", purpose: "匹配应对话术" },
					],
				}),
			]),
		]);
		const streamFn: StreamFn = async (model, context, options) => fa.provider.stream(model as never, context, options);
		const plan = await runPlanPhase({ db, tenantId: "t1", store, streamFn }, { goal: "分析陈静的跟进情况" });
		expect(plan.steps).toHaveLength(2);
		expect(plan.steps[0].tool).toBe("customer_query");
	});

	it("verifyPlan:对照规划工具与实际调用,产出覆盖/缺失", () => {
		const plan = { summary: "s", steps: [{ step: "查客户", tool: "customer_query", purpose: "x" }, { step: "查话术", tool: "knowledge_search", purpose: "y" }] };
		const v1 = verifyPlan(plan, ["customer_query", "knowledge_search"]);
		expect(v1.missingTools).toEqual([]);
		expect(v1.summary).toContain("全部执行");
		const v2 = verifyPlan(plan, ["customer_query"]);
		expect(v2.missingTools).toEqual(["knowledge_search"]);
	});

	it("runSalesAgentWithPlan:规划落库+执行+验证,事件包含 plan/verified", async () => {
		const faPlan = fauxProvider();
		faPlan.setResponses([
			fauxAssistantMessage([
				fauxToolCall("emit_plan", {
					steps: [{ step: "查客户档案", tool: "customer_query", purpose: "拿客户资料" }],
				}),
			]),
		]);
		const faExec = fauxProvider();
		faExec.setResponses([
			fauxAssistantMessage([fauxToolCall("customer_query", { view: "profile", customerKey: "陈静" })]),
			fauxAssistantMessage([fauxToolCall("emit_final", { answer: "陈静档案已查。" })]),
		]);
		let calls = 0;
		const streamFn: StreamFn = async (model, context, options) => {
			calls++;
			return (calls === 1 ? faPlan : faExec).provider.stream(model as never, context, options);
		};
		const events: string[] = [];
		const result = await runSalesAgentWithPlan(
			{ db, tenantId: "t1", store, streamFn },
			{ goal: "查陈静档案", onProgress: (e) => events.push(e.type) },
		);
		expect(result.plan?.steps).toHaveLength(1);
		expect(result.verification?.coveredTools).toEqual(["customer_query"]);
		expect(result.verification?.missingTools).toEqual([]);
		expect(events).toContain("plan");
		expect(events).toContain("verified");
		expect(result.final?.answer).toContain("陈静");
		const record = getAgentPlanByRun(db, "t1", result.runId)!;
		expect(record.status).toBe("verified");
		expect(JSON.parse(record.planJson).steps).toHaveLength(1);
	});
});

describe("客户端中断", () => {
	it("signal 已中止:runSalesAgent 直接抛 AgentCancelledError,不产出答复", async () => {
		const fa = fauxProvider();
		fa.setResponses([fauxAssistantMessage([fauxToolCall("emit_final", { answer: "不应出现的答复" })])]);
		const streamFn: StreamFn = async (model, context, options) => fa.provider.stream(model as never, context, options);
		const controller = new AbortController();
		controller.abort();
		await expect(
			runSalesAgent({ db, tenantId: "t1", store, streamFn }, { goal: "中断测试", signal: controller.signal }),
		).rejects.toBeInstanceOf(AgentCancelledError);
	});

	it("运行中触发 signal:runSalesAgent 抛 AgentCancelledError", async () => {
		const fa = fauxProvider();
		fa.setResponses([fauxAssistantMessage([fauxToolCall("emit_final", { answer: "正常答复" })])]);
		const streamFn: StreamFn = async (model, context, options) => fa.provider.stream(model as never, context, options);
		const controller = new AbortController();
		const pending = runSalesAgent({ db, tenantId: "t1", store, streamFn }, { goal: "运行中中断", signal: controller.signal });
		// 给 agent 一个 tick 的机会进入运行态后再中止
		await new Promise((r) => setTimeout(r, 20));
		controller.abort();
		await expect(pending).rejects.toBeInstanceOf(AgentCancelledError);
	});

	it("runSalesAgentWithPlan:规划阶段中止抛 AgentCancelledError", async () => {
		const fa = fauxProvider();
		fa.setResponses([
			fauxAssistantMessage([fauxToolCall("emit_plan", { summary: "计划", steps: [{ step: "查客户", tool: "query_customer", purpose: "取数" }] })]),
		]);
		const streamFn: StreamFn = async (model, context, options) => fa.provider.stream(model as never, context, options);
		const controller = new AbortController();
		const pending = runSalesAgentWithPlan({ db, tenantId: "t1", store, streamFn }, { goal: "规划中中断", signal: controller.signal });
		await new Promise((r) => setTimeout(r, 20));
		controller.abort();
		await expect(pending).rejects.toBeInstanceOf(AgentCancelledError);
	});
});

describe("多代理模式", () => {
	it("runMultiAgentFlow:主代理建卡->子代理并行执行->协调者汇总输出", async () => {
		const boardFile = path.join(dir, "kanban.json");
		process.env.KANBAN_FILE = boardFile;
		try {
			// 子代理/协调者都输出文本;计划直接传入 multi 模式
			const fa = fauxProvider();
			fa.setResponses([
				fauxAssistantMessage([{ type: "text", text: "子任务A结果" }]),
				fauxAssistantMessage([{ type: "text", text: "子任务B结果" }]),
				fauxAssistantMessage([fauxToolCall("emit_final", { answer: "汇总:两个子任务完成。" })]),
			]);
			const streamFn: StreamFn = async (model, context, options) => fa.provider.stream(model as never, context, options);
			const plan = {
				mode: "multi" as const,
				summary: "并行分析",
				steps: [],
				subtasks: [
					{ title: "分析A", goal: "分析客户A" },
					{ title: "分析B", goal: "分析客户B" },
				],
			};
			const result = await runMultiAgentFlow({ db, tenantId: "t1", store, streamFn }, { goal: "并行分析客户" }, plan);
			expect(result.final?.answer).toContain("汇总");
			const cards = listKanbanCards(db, "t1", { status: "done", threadId: "default" });
			expect(cards).toHaveLength(2);
			expect(cards.every((c) => c.result)).toBe(true);
		} finally {
			delete process.env.KANBAN_FILE;
		}
	});
});