import path from "node:path";
import { mkdirSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { fauxProvider, fauxToolCall, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { buildApp } from "./app.js";
import { openDatabase } from "./db/database.js";
import { requireTenant } from "./repositories/customers.js";
import { cleanupDataDir, tmpDataDir } from "./pi/sessions.js";
import type { MysqlSink } from "./integrations/mysql-sink.js";
import { createMemoryReminderQueue } from "./integrations/reminder-queue.js";

const NOOP_MYSQL: MysqlSink = {
	appendAnalysis: async () => undefined,
	appendVehiclePlan: async () => undefined,
	close: async () => undefined,
};

function trackingMysqlSink(tracker: { analysis: number; vehicle: number }): MysqlSink {
	return {
		appendAnalysis: async () => {
			tracker.analysis++;
		},
		appendVehiclePlan: async () => {
			tracker.vehicle++;
		},
		close: async () => undefined,
	};
}

let app: FastifyInstance | undefined;
let dir: string | undefined;

afterEach(async () => {
	if (app) await app.close();
	if (dir) cleanupDataDir(dir);
});

function fakeStreamFn(): StreamFn {
	const fa = fauxProvider();
	fa.setResponses([
		fauxAssistantMessage([fauxToolCall("knowledge_search", { query: "价格", limit: 3 })]),
		fauxAssistantMessage([
			fauxToolCall("emit_analysis", {
				intent: "价格异议",
				summary: "客户对价格有疑虑",
				signals: [{ kind: "budget", quote: "超出预算", note: "预算有限" }, { kind: "buying_signal", quote: "想买", note: "意向明确" }],
				suggestedReply: "理解您的顾虑,预算把控确实重要。我先跟您坦诚说明旗舰版与低价方案的差异,再结合您的核心需求匹配方案,您最看重哪一块我优先对比。",
				nextSteps: ["发送方案"],
				followupAt: "2020-01-01T00:00:00.000Z",
			}),
		]),
	]);
	return async (model, context, options) => fa.provider.stream(model as never, context, options);
}

function fakeEvaluatorStreamFn(): StreamFn {
	const fa = fauxProvider();
	fa.setResponses([
		fauxAssistantMessage([
			fauxToolCall("emit_evaluation", {
				score: 82,
				dimensions: { empathy: 90, structure: 80, value: 75, compliance: 95, close: 70 },
				strengths: ["共情到位"],
				improvements: ["缺少约试驾的引导"],
				suggestedReply: "理解您的顾虑,约个时间给您做一次演示?",
			}),
		]),
	]);
	return async (model, context, options) => fa.provider.stream(model as never, context, options);
}

function fakeVoiceDigestStreamFn(): StreamFn {
	const fa = fauxProvider();
	fa.setResponses([
		fauxAssistantMessage([
			fauxToolCall("emit_digest", {
				customerProfile: "预算 15-30 万,5 座,商务兼家庭,对新能源接受度高",
				concerns: ["价格偏高", "担心售后网点少"],
				progress: "试驾后比价阶段,存在竞品低价吸引,推进阻力中等",
				suggestedActions: ["发出配置单", "预约二次试驾", "约 3 日内回访"],
				summary: "客户试驾体验良好,主要在价格与售后上犹豫。",
			}),
		]),
	]);
	return async (model, context, options) => fa.provider.stream(model as never, context, options);
}


function fakeAgentNoEmitStreamFn(): StreamFn {
	const fa = fauxProvider();
	fa.setResponses([
		fauxAssistantMessage([fauxToolCall("customer_query", { view: "profile", customerKey: "陈静" })]),
		fauxAssistantMessage([{ type: "text", text: "陈静的档案里暂时没有电话,建议先补录联系方式。" }]),
	]);
	return async (model, context, options) => fa.provider.stream(model as never, context, options);
}

function fakeAgentTableRewriteStreamFn(): StreamFn {
	const fa = fauxProvider();
	fa.setResponses([
		fauxAssistantMessage([fauxToolCall("customer_query", { view: "list", limit: 50 })]),
		fauxAssistantMessage([fauxToolCall("emit_final", { answer: "共 2 位客户,名单如下:\n\n| 客户标识姓名电话阶段 |\n| --- |\n| c_a 王五 13800000001 |", nextSteps: [] })]),
	]);
	return async (model, context, options) => fa.provider.stream(model as never, context, options);
}

function fakeAgentStreamFn(): StreamFn {
	const fa = fauxProvider();
	fa.setResponses([
		fauxAssistantMessage([
			fauxToolCall("emit_final", {
				answer: "参考方案:\n\n| 品牌 | 价格 |\n| --- | --- |\n| 汉EV | 25万 |\n| Model Y | 28万 |",
				summary: "两款推荐",
				nextSteps: ["约试驾"],
			}),
		]),
	]);
	return async (model, context, options) => fa.provider.stream(model as never, context, options);
}

function fakeVehicleStreamFn(): StreamFn {
	const fa = fauxProvider();
	fa.setResponses([
		fauxAssistantMessage([fauxToolCall("vehicle_query", { budgetMin: 15, budgetMax: 30, seats: 5 })]),
		fauxAssistantMessage([
			fauxToolCall("emit_vehicle_plan", {
				profile: "预算 15-30 万,5 座,商务兼家用",
				recommendations: [
					{ brand: "比亚迪", series: "汉", modelName: "汉EV 冠军版", priceText: "19.98-25.98 万", energyType: "纯电", bodyType: "轿车", seats: 5, fitScore: 92, reason: "商务舒适且预算匹配" },
					{ brand: "特斯拉", series: "Model Y", modelName: "Model Y 后驱版", priceText: "24.99-27.99 万", energyType: "纯电", bodyType: "SUV", seats: 5, fitScore: 88, reason: "科技智能,适合通勤" },
				],
				keyDifferences: ["汉EV 轿车商务质感好,Model Y SUV 空间与智驾更强"],
				suggestedReply: "根据您的预算和用途,建议先看汉EV 和 Model Y…",
				nextSteps: ["约试驾", "出配置单"],
			}),
		]),
	]);
	return async (model, context, options) => fa.provider.stream(model as never, context, options);
}

describe("api", () => {
	it("GET / 与 /console 返回分端页面", async () => {
		dir = tmpDataDir("api");
		app = buildApp({ dataDir: dir, mysqlSink: NOOP_MYSQL, reminders: createMemoryReminderQueue() });
		const client = await app.inject({ method: "GET", url: "/" });
		expect(client.statusCode).toBe(200);
		expect(client.headers["content-type"]).toContain("text/html");
		expect(client.body).toContain("销售军师");
		expect(client.body).toContain("业务逻辑功能");

		const consolePage = await app.inject({ method: "GET", url: "/console" });
		expect(consolePage.statusCode).toBe(200);
		expect(consolePage.headers["content-type"]).toContain("text/html");
		expect(consolePage.body).toContain("编排端");
		expect(consolePage.body).toContain("Agent 能力");

		const legacy = await app.inject({ method: "GET", url: "/workspace" });
		expect(legacy.statusCode).toBe(200);
		expect(legacy.body).toContain("panel-knowledge");
		expect(legacy.body).toContain("panel-stores");
	});

	it("手动翻页接口:白名单表格工具 200,非白名单 400", async () => {
		dir = tmpDataDir("api-page");
		app = buildApp({ dataDir: dir, mysqlSink: NOOP_MYSQL, reminders: createMemoryReminderQueue() });
		const bad = await app.inject({ method: "POST", url: "/api/v1/agent/tools/sql/page", payload: { params: { page: 1 } } });
		expect(bad.statusCode).toBe(400);

		const ok = await app.inject({ method: "POST", url: "/api/v1/agent/tools/customer_query/page", payload: { params: { page: 1 } } });
		expect(ok.statusCode).toBe(200);
		const body = ok.json();
		expect(body.details.page).toBe(1);
		expect(body.details.totalPages).toBeGreaterThanOrEqual(1);
		expect(typeof body.details.rawTable).toBe("string");
	});
	it("health 可达", async () => {
		dir = tmpDataDir("api");
		app = buildApp({ dataDir: dir, mysqlSink: NOOP_MYSQL, reminders: createMemoryReminderQueue() });
		const res = await app.inject({ method: "GET", url: "/api/v1/health" });
		expect(res.statusCode).toBe(200);
		expect(res.json().status).toBe("ok");
	});

	it("知识库上传可检索且幂等", async () => {
		dir = tmpDataDir("api-upload");
		app = buildApp({ dataDir: dir, mysqlSink: NOOP_MYSQL, reminders: createMemoryReminderQueue() });
		const first = await app.inject({
			method: "POST",
			url: "/api/v1/knowledge",
			payload: { title: "报价", content: "旗舰版 1999 元/年。" },
			headers: { "x-tenant-id": "t1" },
		});
		expect(first.json().skipped).toBe(false);
		const again = await app.inject({
			method: "POST",
			url: "/api/v1/knowledge",
			payload: { title: "报价", content: "重复内容" },
			headers: { "x-tenant-id": "t1" },
		});
		expect(again.json().skipped).toBe(true);
	});

	it("analyze 自动生成跟进任务,且任务可查询与完成", async () => {
		dir = tmpDataDir("api-tasks");
		app = buildApp({ dataDir: dir, streamFn: fakeStreamFn(), mysqlSink: NOOP_MYSQL, reminders: createMemoryReminderQueue() });
		const headers = { "x-tenant-id": "t1" };
		const res = await app.inject({
			method: "POST",
			url: "/api/v1/copilot/analyze",
			payload: { transcript: "客户:价格多少?", customerKey: "c_task" },
			headers,
		});
		expect(res.statusCode).toBe(200);

		const list = await app.inject({ method: "GET", url: "/api/v1/tasks?status=pending", headers });
		expect(list.statusCode).toBe(200);
		expect(list.json().tasks).toHaveLength(1);
		expect(list.json().tasks[0].action).toBe("发送方案");
		expect(list.json().tasks[0].customerKey).toBe("c_task");

		const taskId = list.json().tasks[0].id;
		const done = await app.inject({ method: "PATCH", url: `/api/v1/tasks/${taskId}/done`, headers });
		expect(done.statusCode).toBe(200);
		expect(done.json().task.status).toBe("done");

		const after = await app.inject({ method: "GET", url: "/api/v1/tasks?status=pending", headers });
		expect(after.json().tasks).toHaveLength(0);
	});
	
	it("车型优选:生成方案并落库可查", async () => {
		dir = tmpDataDir("api-vehicle");
		app = buildApp({ dataDir: dir, streamFn: fakeVehicleStreamFn(), seedVehiclesFor: ["t1"], mysqlSink: NOOP_MYSQL, reminders: createMemoryReminderQueue() });
		const headers = { "x-tenant-id": "t1" };
		const res = await app.inject({
			method: "POST",
			url: "/api/v1/copilot/vehicle-match",
			payload: { customerKey: "c_car", requirements: { budgetMin: 15, budgetMax: 30, seats: 5, usage: "商务兼家用" } },
			headers,
		});
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.planId).toBeTruthy();
		expect(body.plan.recommendations).toHaveLength(2);
		expect(body.plan.recommendations[0].series).toBe("汉");
		expect(body.plan.nextSteps).toContain("约试驾");

		const list = await app.inject({ method: "GET", url: "/api/v1/customers/c_car/vehicle-plans", headers });
		expect(list.statusCode).toBe(200);
		expect(list.json().plans).toHaveLength(1);
		expect(list.json().plans[0].plan.recommendations[0].brand).toBe("比亚迪");
	});
	
	it("analyze 后分析归档到 mysql sink", async () => {
		dir = tmpDataDir("api-mysql");
		const tracker = { analysis: 0, vehicle: 0 };
		app = buildApp({ dataDir: dir, streamFn: fakeStreamFn(), mysqlSink: trackingMysqlSink(tracker), reminders: createMemoryReminderQueue() });
		const res = await app.inject({
			method: "POST",
			url: "/api/v1/copilot/analyze",
			payload: { transcript: "客户:价格多少?", customerKey: "c_mysql" },
			headers: { "x-tenant-id": "t1" },
		});
		expect(res.statusCode).toBe(200);
		expect(tracker.analysis).toBe(1);
	});

	it("多轮 transcript:自动识别发言人完成分析", async () => {
		dir = tmpDataDir("api-multiturn");
		app = buildApp({ dataDir: dir, streamFn: fakeStreamFn(), mysqlSink: NOOP_MYSQL, reminders: createMemoryReminderQueue() });
		const headers = { "x-tenant-id": "t1" };
		const res1 = await app.inject({
			method: "POST",
			url: "/api/v1/copilot/analyze",
			payload: { transcript: "客户:旗舰版多少钱?\n销售:您好,聊聊预算?\n客户:预算1500", customerKey: "c_turn" },
			headers,
		});
		expect(res1.statusCode).toBe(200);
		expect(res1.json().analysis.intent).toBe("价格异议");
	});

	it("messages 数组入参与空会话 400", async () => {
		dir = tmpDataDir("api-msgs");
		app = buildApp({ dataDir: dir, streamFn: fakeStreamFn(), mysqlSink: NOOP_MYSQL, reminders: createMemoryReminderQueue() });
		const headers = { "x-tenant-id": "t1" };

		const bad = await app.inject({
			method: "POST",
			url: "/api/v1/copilot/analyze",
			payload: { transcript: "   ", customerKey: "c_bad" },
			headers,
		});
		expect(bad.statusCode).toBe(400);

		const res2 = await app.inject({
			method: "POST",
			url: "/api/v1/copilot/analyze",
			payload: { messages: [{ role: "sales", content: "您好" }, { role: "customer", content: "有没有现车" }], customerKey: "c_turn2" },
			headers,
		});
		expect(res2.statusCode).toBe(200);
	});
	

	it("经营洞察:聚合分析/任务/车型数据", async () => {
		dir = tmpDataDir("api-insights");
		app = buildApp({ dataDir: dir, mysqlSink: NOOP_MYSQL, reminders: createMemoryReminderQueue() });
		const headers = { "x-tenant-id": "t1" };
		const res = await app.inject({ method: "GET", url: "/api/v1/assistant/insights?days=7", headers });
		expect(res.statusCode).toBe(200);
		expect(res.json().days).toBe(7);
		expect(typeof res.json().taskCompletionRate).toBe("number");
		expect(Array.isArray(res.json().topIntents)).toBe(true);
	});

	it("话术评估:返回评分与改进建议", async () => {
		dir = tmpDataDir("api-eval");
		app = buildApp({ dataDir: dir, streamFn: fakeEvaluatorStreamFn(), mysqlSink: NOOP_MYSQL, reminders: createMemoryReminderQueue() });
		const headers = { "x-tenant-id": "t1" };
		const res = await app.inject({
			method: "POST",
			url: "/api/v1/copilot/evaluate-response",
			payload: { conversation: "客户:太贵了", reply: "不贵啊" },
			headers,
		});
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.conversationId).toBeTruthy();
		expect(body.evaluation.score).toBe(82);
		expect(body.evaluation.dimensions.empathy).toBe(90);
		expect(body.evaluation.improvements.length).toBeGreaterThan(0);
		expect(body.evaluation.suggestedReply).toContain("演示");

		const bad2 = await app.inject({ method: "POST", url: "/api/v1/copilot/evaluate-response", payload: { conversation: "x" }, headers });
		expect(bad2.statusCode).toBe(400);
	});


	it("客户画像标签:分析后自动聚合,可查询", async () => {
		dir = tmpDataDir("api-tags");
		app = buildApp({ dataDir: dir, streamFn: fakeStreamFn(), mysqlSink: NOOP_MYSQL, reminders: createMemoryReminderQueue() });
		const headers = { "x-tenant-id": "t1" };
		await app.inject({ method: "POST", url: "/api/v1/copilot/analyze", payload: { transcript: "客户:价格多少?", customerKey: "c_tag" }, headers });
		const tags = await app.inject({ method: "GET", url: "/api/v1/customers/c_tag/tags", headers });
		expect(tags.statusCode).toBe(200);
		const list = tags.json().tags;
		expect(list.some((x: { tag: string }) => x.tag === "价格敏感")).toBe(true);
		expect(list.some((x: { tag: string }) => x.tag === "高意向")).toBe(true);
	});



	it("规则改进:聚合风险场景与候选流失,输出建议", async () => {
		dir = tmpDataDir("api-improve");
		app = buildApp({ dataDir: dir, mysqlSink: NOOP_MYSQL, reminders: createMemoryReminderQueue() });
		const headers = { "x-tenant-id": "t1" };
		const res = await app.inject({ method: "GET", url: "/api/v1/assistant/improvements?days=30", headers });
		expect(res.statusCode).toBe(200);
		expect(Array.isArray(res.json().suggestions)).toBe(true);
		expect(typeof res.json().analyses).toBe("number");
	});

	it("试驾/通话文字稿摘要:结构化 digest", async () => {
		dir = tmpDataDir("api-digest-voice");
		app = buildApp({ dataDir: dir, streamFn: fakeVoiceDigestStreamFn(), mysqlSink: NOOP_MYSQL, reminders: createMemoryReminderQueue() });
		const headers = { "x-tenant-id": "t1" };
		const res = await app.inject({
			method: "POST",
			url: "/api/v1/copilot/voice-digest",
			payload: { transcript: "客户试驾汉EV,说空间不错,但价格有点高,问售后网点多不多" },
			headers,
		});
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.conversationId).toBeTruthy();
		expect(body.digest.concerns).toContain("价格偏高");
		expect(body.digest.suggestedActions.length).toBeGreaterThanOrEqual(3);

		const bad = await app.inject({ method: "POST", url: "/api/v1/copilot/voice-digest", payload: { transcript: "  " }, headers });
		expect(bad.statusCode).toBe(400);
	});




	it("会话列表与从库内会话分析:不依赖手动粘贴", async () => {
		dir = tmpDataDir("api-conv-flow");
		try {
			app = buildApp({ dataDir: dir, streamFn: fakeStreamFn(), mysqlSink: NOOP_MYSQL, reminders: createMemoryReminderQueue() });
			const headers = { "x-tenant-id": "t1" };
			const res = await app.inject({ method: "POST", url: "/api/v1/copilot/analyze", payload: { transcript: "客户:价格多少?", customerKey: "c_convf" }, headers });
			expect(res.statusCode).toBe(200);
			const convId = res.json().conversationId;
			const list = await app.inject({ method: "GET", url: "/api/v1/conversations", headers });
			expect(list.statusCode).toBe(200);
			expect(list.json().conversations).toHaveLength(1);
			expect(list.json().conversations[0].id).toBe(convId);
			expect(list.json().conversations[0].customerKey).toBe("c_convf");
			expect(list.json().conversations[0].messageCount).toBeGreaterThan(0);
			await app.close(); app = undefined;

			// 新实例(同一数据目录)从库读取会话原文再分析
			app = buildApp({ dataDir: dir, streamFn: fakeStreamFn(), mysqlSink: NOOP_MYSQL, reminders: createMemoryReminderQueue() });
			const again = await app.inject({ method: "POST", url: `/api/v1/conversations/${convId}/analyze`, headers });
			expect(again.statusCode).toBe(200);
			expect(again.json().analysisId).toBeTruthy();
			const list2 = await app.inject({ method: "GET", url: "/api/v1/conversations", headers });
			expect(list2.json().conversations[0].messageCount).toBeGreaterThan(0);
		} finally {
			if (app) await app.close();
			app = undefined;
			if (dir) cleanupDataDir(dir);
			dir = undefined;
		}
	});


	it("通知推送:到期任务触发记录,重复触发去重", async () => {
		dir = tmpDataDir("api-notify");
		const queue = createMemoryReminderQueue();
		app = buildApp({ dataDir: dir, streamFn: fakeStreamFn(), mysqlSink: NOOP_MYSQL, reminders: queue });
		const headers = { "x-tenant-id": "t1" };
		await app.inject({ method: "POST", url: "/api/v1/copilot/analyze", payload: { transcript: "客户:价格多少?", customerKey: "c_notify" }, headers });
		const first = await app.inject({ method: "POST", url: "/api/v1/notifications/trigger", headers });
		expect(first.statusCode).toBe(200);
		expect(first.json().newlyNotified.length).toBe(1);
		expect(first.json().pushed).toBe(false);
		const logs = await app.inject({ method: "GET", url: "/api/v1/notifications", headers });
		expect(logs.json().logs.length).toBe(1);
		expect(logs.json().logs[0].status).toBe("sent");
		const second = await app.inject({ method: "POST", url: "/api/v1/notifications/trigger", headers });
		expect(second.json().newlyNotified).toEqual([]);
	});


	it("时间线:分析后的事件序列可回放", async () => {
		dir = tmpDataDir("api-timeline");
		app = buildApp({ dataDir: dir, streamFn: fakeStreamFn(), mysqlSink: NOOP_MYSQL, reminders: createMemoryReminderQueue() });
		const headers = { "x-tenant-id": "t1" };
		const res = await app.inject({
			method: "POST",
			url: "/api/v1/copilot/analyze",
			payload: { transcript: "客户:价格多少?", customerKey: "c_tl" },
			headers,
		});
		expect(res.statusCode).toBe(200);
		const conversationId = res.json().conversationId;

		const tl = await app.inject({ method: "GET", url: `/api/v1/conversations/${conversationId}/timeline`, headers });
		expect(tl.statusCode).toBe(200);
		const types = tl.json().events.map((e: { type: string }) => e.type);
		expect(types).toContain("agent_start");
		expect(types).toContain("tool_start");
		expect(types).toContain("tool_end");
		expect(tl.json().events.some((e: { type: string; toolName?: string }) => e.type === "tool_end" && e.toolName === "emit_analysis")).toBe(true);
		// 按序递增
		const seqs = tl.json().events.map((e: { seq: number }) => e.seq);
		expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
	});
	
	it("知识库批量导入:分类+多条知识点+幂等", async () => {
		dir = tmpDataDir("api-kb");
		app = buildApp({ dataDir: dir, mysqlSink: NOOP_MYSQL, reminders: createMemoryReminderQueue() });
		const headers = { "x-tenant-id": "t1" };
		const res = await app.inject({
			method: "POST",
			url: "/api/v1/knowledge/batch",
			payload: { category: "价格政策", entries: [{ title: "旗舰版价格", content: "旗舰版 1999 元/年" }, { title: "标准版价格", content: "标准版 999 元/年" }] },
			headers,
		});
		expect(res.statusCode).toBe(200);
		expect(res.json().results).toHaveLength(2);
		expect(res.json().results[0].skipped).toBe(false);
		const search = await app.inject({ method: "GET", url: "/api/v1/knowledge/search?q=1999", headers });
		expect(search.json().hits.some((h: { category?: string | null }) => h.category === "价格政策")).toBe(true);
		// 幂等:再传一遍全部跳过
		const again = await app.inject({
			method: "POST",
			url: "/api/v1/knowledge/batch",
			payload: { category: "价格政策", entries: [{ title: "旗舰版价格", content: "x" }, { title: "标准版价格", content: "x" }] },
			headers,
		});
		expect(again.json().results.every((r: { skipped: boolean }) => r.skipped)).toBe(true);
	});


	it("知识沉淀:分析后生成话术候选,确认入库后可检索", async () => {
		dir = tmpDataDir("api-candidates");
		app = buildApp({ dataDir: dir, streamFn: fakeStreamFn(), mysqlSink: NOOP_MYSQL, reminders: createMemoryReminderQueue() });
		const headers = { "x-tenant-id": "t1" };
		const res = await app.inject({
			method: "POST",
			url: "/api/v1/copilot/analyze",
			payload: { transcript: "客户:价格多少?", customerKey: "c_mem" },
			headers,
		});
		expect(res.statusCode).toBe(200);

		const list = await app.inject({ method: "GET", url: "/api/v1/knowledge/candidates?status=pending", headers });
		expect(list.statusCode).toBe(200);
		expect(list.json().candidates).toHaveLength(1);
		const candidate = list.json().candidates[0];
		expect(candidate.intent).toBe("价格异议");
		expect(candidate.draftContent).toContain("预算把控");

		const approve = await app.inject({ method: "POST", url: `/api/v1/knowledge/candidates/${candidate.id}/approve`, headers });
		expect(approve.statusCode).toBe(200);
		expect(approve.json().candidate.status).toBe("approved");
		expect(approve.json().candidate.documentId).toBeTruthy();

		const search = await app.inject({ method: "GET", url: "/api/v1/knowledge/search?q=差异", headers });
		expect(search.statusCode).toBe(200);
		expect(search.json().hits.length).toBeGreaterThan(0);

		const after = await app.inject({ method: "GET", url: "/api/v1/knowledge/candidates?status=pending", headers });
		expect(after.json().candidates).toHaveLength(0);
	});
		it("军师晨报:生成(当日幂等)并列出历史", async () => {
		dir = tmpDataDir("api-digest");
		app = buildApp({ dataDir: dir, mysqlSink: NOOP_MYSQL, reminders: createMemoryReminderQueue() });
		const headers = { "x-tenant-id": "t1" };

		const first = await app.inject({ method: "POST", url: "/api/v1/assistant/digest", headers });
		expect(first.statusCode).toBe(200);
		expect(first.json().reused).toBe(false);
		expect(first.json().title).toContain("销售军师晨报");
		expect(first.json().stats.pendingTasks).toBe(0);

		const second = await app.inject({ method: "POST", url: "/api/v1/assistant/digest", headers });
		expect(second.json().reused).toBe(true);

		const list = await app.inject({ method: "GET", url: "/api/v1/assistant/digests", headers });
		expect(list.statusCode).toBe(200);
		expect(list.json().digests).toHaveLength(1);
	});
		it("提醒闭环:到期任务出现在 overdue,完成后出队", async () => {
		dir = tmpDataDir("api-remind");
		const queue = createMemoryReminderQueue();
		app = buildApp({ dataDir: dir, streamFn: fakeStreamFn(), mysqlSink: NOOP_MYSQL, reminders: queue });
		const headers = { "x-tenant-id": "t1" };
		const res = await app.inject({
			method: "POST",
			url: "/api/v1/copilot/analyze",
			payload: { transcript: "客户:价格多少?", customerKey: "c_remind" },
			headers,
		});
		expect(res.statusCode).toBe(200);

		const overdue = await app.inject({ method: "GET", url: "/api/v1/reminders/overdue", headers });
		expect(overdue.statusCode).toBe(200);
		expect(overdue.json().overdue).toHaveLength(1);
		expect(overdue.json().overdue[0].customerKey).toBe("c_remind");
		const taskId = overdue.json().overdue[0].id;

		const done = await app.inject({ method: "PATCH", url: `/api/v1/tasks/${taskId}/done`, headers });
		expect(done.statusCode).toBe(200);
		const after = await app.inject({ method: "GET", url: "/api/v1/reminders/overdue", headers });
		expect(after.json().overdue).toHaveLength(0);
	});
		it("analyze 全链路:分析落库并可查", async () => {
		dir = tmpDataDir("api-analyze");
		app = buildApp({ dataDir: dir, streamFn: fakeStreamFn(), mysqlSink: NOOP_MYSQL, reminders: createMemoryReminderQueue() });
		const res = await app.inject({
			method: "POST",
			url: "/api/v1/copilot/analyze",
			payload: { transcript: "客户:价格多少?有点贵", customerKey: "c_tsla" },
			headers: { "x-tenant-id": "t1" },
		});
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.analysisId).toBeTruthy();
		expect(body.conversationId).toBeTruthy();
		expect(body.analysis.intent).toBe("价格异议");
		expect(body.analysis.nextSteps).toContain("发送方案");

		const list = await app.inject({
			method: "GET",
			url: "/api/v1/customers/c_tsla/analyses",
			headers: { "x-tenant-id": "t1" },
		});
		expect(list.json().analyses).toHaveLength(1);
	});

	it("门店管理:门店/销售/成交落库,概览聚合与店长范围校验", async () => {
		dir = tmpDataDir("api-stores");
		app = buildApp({ dataDir: dir, seedVehiclesFor: ["t1"], mysqlSink: NOOP_MYSQL, reminders: createMemoryReminderQueue() });
		const headers = { "x-tenant-id": "t1" };
		const created = await app.inject({ method: "POST", url: "/api/v1/stores", payload: { name: "测试店", address: "苏州", managerName: "测试店长", managerPhone: "13800000009" }, headers });
		expect(created.statusCode).toBe(200);
		const storeId = created.json().store.id;

		const list = await app.inject({ method: "GET", url: "/api/v1/stores", headers });
		expect(list.statusCode).toBe(200);
		expect(list.json().stores.some((s: { id: string }) => s.id === storeId)).toBe(true);

		const salesRes = await app.inject({ method: "POST", url: "/api/v1/sales", payload: { storeId, name: "测试销售", phone: "13900000009" }, headers });
		expect(salesRes.statusCode).toBe(200);
		const salesId = salesRes.json().salesperson.id;

		const dealRes = await app.inject({ method: "POST", url: "/api/v1/deals", payload: { customerKey: "c_deal_api", salesId, amount: 199900, dealedAt: "2026-09-01T08:00:00Z" }, headers });
		expect(dealRes.statusCode).toBe(200);
		expect(dealRes.json().deal.amount).toBe(199900);
		expect(dealRes.json().deal.store_id).toBe(storeId);

		const deals = await app.inject({ method: "GET", url: "/api/v1/deals?storeId=" + storeId, headers });
		expect(deals.statusCode).toBe(200);
		expect(deals.json().deals).toHaveLength(1);
		expect(deals.json().deals[0].salesName).toBe("测试销售");

		const overview = await app.inject({ method: "GET", url: `/api/v1/stores/${storeId}/overview?from=2026-01-01T00:00:00Z&to=2030-01-01T00:00:00Z`, headers });
		expect(overview.statusCode).toBe(200);
		expect(overview.json().deals).toBe(1);
		expect(overview.json().amount).toBe(199900);
		expect(overview.json().orders).toHaveLength(1);

		// 店长范围:不能看其他门店,能看自己门店
		const detail = await app.inject({ method: "GET", url: `/api/v1/stores/${storeId}`, headers });
		const managerId = detail.json().manager.id;
		const seedStoreId = list.json().stores.find((s: { name: string }) => s.name === "苏州旗舰店").id;
		const denied = await app.inject({ method: "GET", url: `/api/v1/stores/${seedStoreId}/overview`, headers: { ...headers, "x-sales-id": managerId } });
		expect(denied.statusCode).toBe(403);
		const own = await app.inject({ method: "GET", url: `/api/v1/stores/${storeId}/overview`, headers: { ...headers, "x-sales-id": managerId } });
		expect(own.statusCode).toBe(200);
	});

	it("analyze 后对话原文落库:时间/角色/内容可查,响应与接口带 transcript", async () => {
		dir = tmpDataDir("api-transcript");
		app = buildApp({ dataDir: dir, streamFn: fakeStreamFn(), mysqlSink: NOOP_MYSQL, reminders: createMemoryReminderQueue() });
		const headers = { "x-tenant-id": "t1" };
		const res = await app.inject({
			method: "POST",
			url: "/api/v1/copilot/analyze",
			payload: {
				messages: [
					{ role: "customer", content: "汉EV 多少钱?", spokenAt: "2026-09-01T08:00:00Z" },
					{ role: "sales", content: "20 万左右,看配置", spokenAt: "2026-09-01T08:01:00Z" },
				],
				customerKey: "c_tr",
				customerName: "王总",
				customerPhone: "13700000000",
				salesName: "李销售",
			},
			headers,
		});
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.cached).toBe(false);
		expect(body.transcript).toHaveLength(2);
		expect(body.transcript[0].spokenAt).toBe("2026-09-01T08:00:00Z");
		expect(body.transcript[1].speakerRole).toBe("sales");

		const tr = await app.inject({ method: "GET", url: `/api/v1/conversations/${body.conversationId}/transcript`, headers });
		expect(tr.statusCode).toBe(200);
		expect(tr.json().transcript).toHaveLength(2);
		expect(tr.json().transcript[0].speakerRole).toBe("customer");
		expect(tr.json().transcript[0].content).toBe("汉EV 多少钱?");
		expect(tr.json().conversation.salesName).toBe("李销售");
		expect(tr.json().conversation.customerName).toBe("王总");
		expect(tr.json().customer.phone).toBe("13700000000");
		expect(tr.json().conversation.followupAdvice).toBe("发送方案");
	});

	it("相同 analyze 请求命中缓存:第二次不再调用模型", async () => {
		dir = tmpDataDir("api-cache");
		let calls = 0;
		const base = fakeStreamFn();
		const counted: StreamFn = async (model, context, options) => {
			calls++;
			return base(model, context, options);
		};
		app = buildApp({ dataDir: dir, streamFn: counted, mysqlSink: NOOP_MYSQL, reminders: createMemoryReminderQueue() });
		const headers = { "x-tenant-id": "t1" };
		const payload = { transcript: "客户:价格多少?", customerKey: "c_hit" };
		const first = await app.inject({ method: "POST", url: "/api/v1/copilot/analyze", payload, headers });
		expect(first.statusCode).toBe(200);
		expect(first.json().cached).toBe(false);
		const callsAfterFirst = calls;
		const second = await app.inject({ method: "POST", url: "/api/v1/copilot/analyze", payload, headers });
		expect(second.statusCode).toBe(200);
		expect(second.json().cached).toBe(true);
		expect(second.json().analysisId).toBe(first.json().analysisId);
		expect(calls).toBe(callsAfterFirst);
	})

	it("AI 助销流式:run-stream 逐块 delta,合并等于最终答复", async () => {
		dir = tmpDataDir("api-stream");
		app = buildApp({ dataDir: dir, streamFn: fakeAgentStreamFn(), mysqlSink: NOOP_MYSQL, reminders: createMemoryReminderQueue() });
		const headers = { "x-tenant-id": "t1" };
		const t = await app.inject({ method: "POST", url: "/api/v1/agent/threads", headers });
		const threadId = t.json().id;
		const res = await app.inject({ method: "POST", url: `/api/v1/agent/threads/${threadId}/run-stream`, payload: { goal: "用表格列出两款车型" }, headers });
		expect(res.statusCode).toBe(200);
		const events = res.body.split("\n").filter(Boolean).map((l) => JSON.parse(l));
		const deltas = events.filter((e: { type: string }) => e.type === "delta").map((e: { text: string }) => e.text).join("");
		const finals = events.filter((e: { type: string }) => e.type === "final");
		expect(deltas.length).toBeGreaterThan(0);
		expect(finals).toHaveLength(1);
		expect(deltas).toBe(finals[0].final.answer);
		expect(events.some((e: { type: string }) => e.type === "tool_start" || e.type === "tool_end")).toBe(true);
	});

	it("模型未调用 emit_final 时,兜底把最后一条 assistant 文本作为答复", async () => {
		dir = tmpDataDir("api-noemit");
		app = buildApp({ dataDir: dir, streamFn: fakeAgentNoEmitStreamFn(), mysqlSink: NOOP_MYSQL, reminders: createMemoryReminderQueue() });
		const headers = { "x-tenant-id": "t1" };
		const t = await app.inject({ method: "POST", url: "/api/v1/agent/threads", headers });
		const res = await app.inject({ method: "POST", url: `/api/v1/agent/threads/${t.json().id}/run-stream`, payload: { goal: "陈静的电话号是多少" }, headers });
		expect(res.statusCode).toBe(200);
		const events = res.body.split("\n").filter(Boolean).map((l) => JSON.parse(l));
		const finals = events.filter((e: { type: string }) => e.type === "final");
		expect(finals).toHaveLength(1);
		expect(finals[0].final.answer).toContain("陈静");
	});

	it("历史会话一键清理:DELETE /agent/threads 清空线程", async () => {
		dir = tmpDataDir("api-threads-clear");
		app = buildApp({ dataDir: dir, mysqlSink: NOOP_MYSQL, reminders: createMemoryReminderQueue() });
		const headers = { "x-tenant-id": "t1" };
		const created = await app.inject({ method: "POST", url: "/api/v1/agent/threads", headers });
		expect(created.statusCode).toBe(200);
		const list1 = await app.inject({ method: "GET", url: "/api/v1/agent/threads", headers });
		expect(list1.json().threads.length).toBeGreaterThan(0);
		const del = await app.inject({ method: "DELETE", url: "/api/v1/agent/threads", headers });
		expect(del.statusCode).toBe(200);
		expect(del.json().removed).toBeGreaterThan(0);
		const list2 = await app.inject({ method: "GET", url: "/api/v1/agent/threads", headers });
		expect(list2.json().threads).toHaveLength(0);
	});

	it("表格保真:模型未原样输出表格时,最终答复自动追加工具原始表格", async () => {
		dir = tmpDataDir("api-table-faith");
		mkdirSync(dir, { recursive: true });
		const db0 = openDatabase(path.join(dir, "business.db"));
		requireTenant(db0, "t1", "测试租户");
		db0.prepare("INSERT INTO customers (id, tenant_id, key, name, phone) VALUES (?,?,?,?,?)").run("cid1", "t1", "c_a", "王五", "13800000001");
		db0.prepare("INSERT INTO customers (id, tenant_id, key, name, phone) VALUES (?,?,?,?,?)").run("cid2", "t1", "c_b", "陈六", "13800000002");
		db0.close();
		app = buildApp({ dataDir: dir, streamFn: fakeAgentTableRewriteStreamFn(), mysqlSink: NOOP_MYSQL, reminders: createMemoryReminderQueue() });
		const headers = { "x-tenant-id": "t1" };
		const t = await app.inject({ method: "POST", url: "/api/v1/agent/threads", headers });
		const res = await app.inject({ method: "POST", url: `/api/v1/agent/threads/${t.json().id}/run-stream`, payload: { goal: "列出客户表格" }, headers });
		expect(res.statusCode).toBe(200);
		const events = res.body.split("\n").filter(Boolean).map((l) => JSON.parse(l));
		const finals = events.filter((e: { type: string }) => e.type === "final");
		expect(finals).toHaveLength(1);
		const answer = finals[0].final.answer;
		expect(answer).toContain("共 2 位客户");
		expect(answer).toContain("| 客户标识 |");
		expect(answer).toContain("王五");
		// 模型转述的错误表格被移除,只保留工具原始表格一份
		expect(answer).not.toContain("| 客户标识姓名电话阶段 |");
		expect((answer.match(/\| 客户标识 \|/g) || []).length).toBe(1);
		expect(answer).toContain("13800000001");
	});

	it("单个历史会话:导出完整对话与删除", async () => {
		dir = tmpDataDir("api-thread-one");
		app = buildApp({ dataDir: dir, streamFn: fakeAgentStreamFn(), mysqlSink: NOOP_MYSQL, reminders: createMemoryReminderQueue() });
		const headers = { "x-tenant-id": "t1" };
		const t = await app.inject({ method: "POST", url: "/api/v1/agent/threads", headers });
		const id = t.json().id;
		await app.inject({ method: "POST", url: `/api/v1/agent/threads/${id}/run-stream`, payload: { goal: "用表格列出两款车型" }, headers });
		const exp = await app.inject({ method: "GET", url: `/api/v1/agent/threads/${id}/export`, headers });
		expect(exp.statusCode).toBe(200);
		expect(exp.json().thread.id).toBe(id);
		expect(exp.json().messages.length).toBeGreaterThan(0);
		const del = await app.inject({ method: "DELETE", url: `/api/v1/agent/threads/${id}`, headers });
		expect(del.statusCode).toBe(200);
		expect(del.json().removed).toBe(true);
		const again = await app.inject({ method: "GET", url: `/api/v1/agent/threads/${id}/export`, headers });
		expect(again.statusCode).toBe(404);
	});
});
