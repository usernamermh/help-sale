import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { fauxProvider, fauxToolCall, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { buildApp } from "./app.js";
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
		fauxAssistantMessage([fauxToolCall("search_playbook", { query: "价格", limit: 3 })]),
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

function fakeVehicleStreamFn(): StreamFn {
	const fa = fauxProvider();
	fa.setResponses([
		fauxAssistantMessage([fauxToolCall("search_vehicles", { budgetMin: 15, budgetMax: 30, seats: 5 })]),
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
	it("GET / 返回前端工具页", async () => {
		dir = tmpDataDir("api");
		app = buildApp({ dataDir: dir, mysqlSink: NOOP_MYSQL, reminders: createMemoryReminderQueue() });
		const res = await app.inject({ method: "GET", url: "/" });
		expect(res.statusCode).toBe(200);
		expect(res.headers["content-type"]).toContain("text/html");
		expect(res.body).toContain("销售军师");
		expect(res.body).toContain("copilot/analyze");
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
});