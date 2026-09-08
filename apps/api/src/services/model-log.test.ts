import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { aggregateSseResponse, appendModelCallLog, readModelCallLogs, wrapFetchWithModelLog } from "./model-log.js";

const dirs: string[] = [];
function tmpDir(prefix: string): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("model-log", () => {
	it("appendModelCallLog 自动创建目录并写 NDJSON 行", () => {
		const dir = tmpDir("model-log-");
		const file = path.join(dir, "model-calls.log");
		appendModelCallLog(dir, { modelId: "m1", request: { q: 1 }, response: { a: 2 }, status: 200, durationMs: 12 }, 8388608);
		appendModelCallLog(dir, { modelId: "m1", request: {}, response: {}, status: 200 }, 8388608);
		expect(fs.existsSync(file)).toBe(true);
		const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
		expect(lines).toHaveLength(2);
		const first = JSON.parse(lines[0]) as { modelId: string; request: { q: number }; response: { a: number }; ts: string };
		expect(first.modelId).toBe("m1");
		expect(first.request).toEqual({ q: 1 });
		expect(first.ts).toBeTruthy();
	});

	it("超过 maxBytes 时轮转保留最近行", () => {
		const dir = tmpDir("model-log-rot-");
		for (let i = 0; i < 40; i++) {
			appendModelCallLog(dir, { modelId: "m", request: `r${i}`, response: `s${i}`, status: 200 }, 300);
		}
		const lines = readModelCallLogs(dir);
		expect(lines.length).toBeGreaterThan(0);
		expect(lines.length).toBeLessThan(40);
		expect(lines[lines.length - 1].request).toBe("r39");
	});

	it("wrapFetchWithModelLog 请求行只记 ID,响应行写完整请求/返回并带同一 ID", async () => {
		const dir = tmpDir("model-log-wrap-");
		const fakeFetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: "hello" } }] }), { status: 200, headers: { "content-type": "application/json" } });
		const wrapped = wrapFetchWithModelLog(fakeFetch as typeof fetch, { enabled: true, dir, maxBytes: 8388608 }, { modelId: "test-model" });
		const res = await wrapped("http://example.test/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }) });
		expect(res.status).toBe(200);
		// 请求行在 fetch 返回前已同步写入:只有请求 ID,不落完整请求体
		let lines = readModelCallLogs(dir);
		expect(lines).toHaveLength(1);
		expect(lines[0].event).toBe("request");
		expect(lines[0].modelId).toBe("test-model");
		expect(lines[0].requestId).toBeTruthy();
		expect(lines[0].request).toBeUndefined();
		// 消费响应后异步补响应行:完整请求 + 返回 + 同一请求 ID
		expect((await res.text()).includes("hello")).toBe(true);
		await new Promise((r) => setTimeout(r, 30));
		lines = readModelCallLogs(dir);
		expect(lines).toHaveLength(2);
		expect(lines[1].event).toBe("response");
		expect(lines[1].requestId).toBe(lines[0].requestId);
		expect(lines[1].status).toBe(200);
		expect((lines[1].request as { messages: Array<{ content: string }> }).messages[0].content).toBe("hi");
		expect((lines[1].response as { choices: Array<{ message: { content: string } }> }).choices[0].message.content).toBe("hello");
		expect(lines[1].durationMs).toBeGreaterThanOrEqual(0);
	});

	it("wrapFetchWithModelLog fetch 异常时落 error 行并向上抛出", async () => {
		const dir = tmpDir("model-log-err-");
		const fakeFetch = async () => {
			throw new Error("connection refused");
		};
		const wrapped = wrapFetchWithModelLog(fakeFetch as typeof fetch, { enabled: true, dir, maxBytes: 8388608 }, { modelId: "test-model" });
		await expect(wrapped("http://example.test/v1/chat/completions", { method: "POST", body: '{"q":1}' })).rejects.toThrow("connection refused");
		await new Promise((r) => setTimeout(r, 20));
		const lines = readModelCallLogs(dir);
		expect(lines).toHaveLength(2);
		expect(lines[0].event).toBe("request");
		expect(lines[0].request).toBeUndefined();
		expect(lines[1].event).toBe("error");
		expect(lines[1].requestId).toBe(lines[0].requestId);
		expect(lines[1].error).toContain("connection refused");
		expect(lines[1].request).toEqual({ q: 1 });
	});

	it("关闭日志时不写文件", async () => {
		const dir = tmpDir("model-log-off-");
		const fakeFetch = async () => new Response("{}", { status: 200 });
		const wrapped = wrapFetchWithModelLog(fakeFetch as typeof fetch, { enabled: false, dir, maxBytes: 8388608 }, { modelId: "m" });
		await wrapped("http://x/chat/completions", { method: "POST", body: "{}" });
		await new Promise((r) => setTimeout(r, 20));
		expect(fs.existsSync(path.join(dir, "model-calls.log"))).toBe(false);
});

});
describe("aggregateSseResponse", () => {
	it("SSE 流聚合为最终输入输出(推理/内容/工具调用/用量)", () => {
		const sse = [
			'data: {"choices":[{"delta":{"role":"assistant","reasoning_content":"先"}}]}',
			'data: {"choices":[{"delta":{"reasoning_content":"思考"}}]}',
			'data: {"choices":[{"delta":{"content":"你好"}}]}',
			'data: {"choices":[{"delta":{"content":"世界"}}]}',
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"emit_analysis","arguments":"{\\"intent\\":"}}]}}]}',
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"价格异议\\"}"}}]}}]}',
			'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
			'data: {"usage":{"prompt_tokens":10,"completion_tokens":8,"total_tokens":18}}',
			'data: [DONE]',
		].join("\n");
		const out = aggregateSseResponse(sse) as { content: string; reasoning: string; toolCalls: Array<{ id: string; name: string; arguments: string }>; finishReason: string; usage: { total_tokens: number }; chunkCount: number };
		expect(out.content).toBe("你好世界");
		expect(out.reasoning).toBe("先思考");
		expect(out.toolCalls).toHaveLength(1);
		expect(out.toolCalls[0].id).toBe("call_1");
		expect(out.toolCalls[0].name).toBe("emit_analysis");
		expect(out.toolCalls[0].arguments).toBe('{"intent":"价格异议"}');
		expect(out.finishReason).toBe("tool_calls");
		expect(out.usage.total_tokens).toBe(18);
		expect(out.chunkCount).toBe(8);
	});

	it("非 SSE 文本原样返回", () => {
		expect(aggregateSseResponse("plain json")).toBe("plain json");
		expect(aggregateSseResponse('{"choices":[]}')).toBe('{"choices":[]}');
	});
});