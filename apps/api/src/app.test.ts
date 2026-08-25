import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { fauxProvider, fauxToolCall, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { buildApp } from "./app.js";
import { cleanupDataDir, tmpDataDir } from "./pi/sessions.js";

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
				signals: [{ kind: "budget", quote: "超出预算", note: "预算有限" }],
				suggestedReply: "先共情再讲 ROI",
				nextSteps: ["发送方案"],
			}),
		]),
	]);
	return async (model, context, options) => fa.provider.stream(model as never, context, options);
}

describe("api", () => {
	it("GET / 返回前端工具页", async () => {
		dir = tmpDataDir("api");
		app = buildApp({ dataDir: dir });
		const res = await app.inject({ method: "GET", url: "/" });
		expect(res.statusCode).toBe(200);
		expect(res.headers["content-type"]).toContain("text/html");
		expect(res.body).toContain("销售军师");
		expect(res.body).toContain("copilot/analyze");
	});

	it("health 可达", async () => {
		dir = tmpDataDir("api");
		app = buildApp({ dataDir: dir });
		const res = await app.inject({ method: "GET", url: "/api/v1/health" });
		expect(res.statusCode).toBe(200);
		expect(res.json().status).toBe("ok");
	});

	it("知识库上传可检索且幂等", async () => {
		dir = tmpDataDir("api-upload");
		app = buildApp({ dataDir: dir });
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
		app = buildApp({ dataDir: dir, streamFn: fakeStreamFn() });
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
		it("analyze 全链路:分析落库并可查", async () => {
		dir = tmpDataDir("api-analyze");
		app = buildApp({ dataDir: dir, streamFn: fakeStreamFn() });
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