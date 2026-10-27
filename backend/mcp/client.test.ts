import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpClient, mcpToolToAgentTool } from "./client.js";

/** 模拟外部 MCP Server 的响应序列。 */
let responses: Array<Record<string, unknown>> = [];
let requests: Array<{ method: string; params?: unknown }> = [];

beforeEach(() => {
	responses = [];
	requests = [];
	vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body));
		requests.push({ method: body.method, params: body.params });
		let next: Record<string, unknown>;
		if (body.method === "notifications/initialized") {
			next = { result: {} }; // 通知无业务响应,不消费队列
		} else {
			next = responses.shift() ?? { result: {} };
		}
		const text = JSON.stringify({ jsonrpc: "2.0", id: body.id, ...next });
		return {
			ok: true,
			status: 200,
			statusText: "OK",
			headers: { get: () => "application/json" },
			text: async () => text,
		} as unknown as Response;
	}));
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("MCP 客户端", () => {
	it("initialize 后 listTools 返回外部工具列表", async () => {
		responses = [
			{ result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "remote", version: "1.0" } } },
			{ result: { tools: [{ name: "get_time", description: "返回当前时间", inputSchema: { type: "object", properties: {} } }] } },
		];
		const client = new McpClient({ name: "remote", url: "https://example.com/mcp" });
		const tools = await client.listTools();
		expect(tools).toHaveLength(1);
		expect(tools[0].name).toBe("get_time");
		const methods = requests.filter((r) => r.method !== "notifications/initialized").map((r) => r.method);
		expect(methods).toEqual(["initialize", "tools/list"]);
	});

	it("callTool 转发参数并返回文本结果", async () => {
		responses = [
			{ result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "remote", version: "1.0" } } },
			{ result: { content: [{ type: "text", text: "现在是 10:30" }], isError: false } },
		];
		const client = new McpClient({ name: "remote", url: "https://example.com/mcp" });
		const result = await client.callTool("get_time", { zone: "Asia/Shanghai" });
		expect(result.content[0].text).toContain("10:30");
		const calls = requests.filter((r) => r.method !== "notifications/initialized");
		expect(calls[1].method).toBe("tools/call");
		expect(calls[1].params).toMatchObject({ name: "get_time", arguments: { zone: "Asia/Shanghai" } });
	});

	it("mcpToolToAgentTool 适配为内部工具,带 mcp_{server}_ 前缀", async () => {
		responses = [
			{ result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "remote", version: "1.0" } } },
			{ result: { content: [{ type: "text", text: "ok" }], isError: false } },
		];
		const client = new McpClient({ name: "remote", url: "https://example.com/mcp" });
		const agentTool = mcpToolToAgentTool("remote", { name: "get_time", description: "取时间", inputSchema: { type: "object" } }, client);
		expect(agentTool.name).toBe("mcp_remote_get_time");
		expect(agentTool.description).toBe("取时间");
		const out = await agentTool.execute("id", { zone: "UTC" });
		expect(out.content).toContainEqual({ type: "text", text: "ok" });
	});

	it("外部工具 isError 时抛错", async () => {
		responses = [
			{ result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "remote", version: "1.0" } } },
			{ result: { content: [{ type: "text", text: "失败原因" }], isError: true } },
		];
		const client = new McpClient({ name: "remote", url: "https://example.com/mcp" });
		const agentTool = mcpToolToAgentTool("remote", { name: "bad", inputSchema: {} }, client);
		await expect(agentTool.execute("id", {})).rejects.toThrow("失败原因");
	});

	it("外部工具元数据含中文时打告警(英文元数据是检索链路的既定前提)", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		responses = [
			{ result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "remote", version: "1.0" } } },
			{
				result: {
					tools: [
						{ name: "chinese_tool", description: "返回当前时间", inputSchema: { type: "object", properties: { tz: { description: "时区" } } } },
						{ name: "english_tool", description: "Return the current time", inputSchema: { type: "object", properties: { tz: { description: "timezone" } } } },
					],
				},
			},
		];
		const client = new McpClient({ name: "someone-else", url: "https://chinese.example/mcp" });
		await client.listTools();
		expect(warn).toHaveBeenCalledTimes(1);
		const message = String(warn.mock.calls[0][0]);
		expect(message).toContain("someone-else");
		expect(message).toContain("1/2");
		expect(message).toContain("chinese_tool[description/inputSchema]");
		expect(message).not.toContain("english_tool");
		warn.mockRestore();
	});

	it("工具元数据全英文时不打告警", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		responses = [
			{ result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "remote", version: "1.0" } } },
			{ result: { tools: [{ name: "get_time", description: "Return the current time", inputSchema: { type: "object" } }] } },
		];
		const client = new McpClient({ name: "remote", url: "https://english.example/mcp" });
		await client.listTools();
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});

	it("连接失败时抛错", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
		const client = new McpClient({ name: "remote", url: "http://127.0.0.1:1/mcp" });
		await expect(client.listTools()).rejects.toThrow("MCP 连接失败");
	});
});