import { describe, expect, it } from "vitest";
import { McpServer, toMcpTool } from "./protocol.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";

const fakeTool: AgentTool<any, any> = {
	name: "echo",
	label: "回声",
	description: "原样返回参数",
	parameters: { type: "object", properties: { text: { type: "string" } } } as any,
	execute: async (_id, params: any) => ({ content: [{ type: "text", text: params?.text ?? "" }], details: null }),
};

function makeServer() {
	const ctx = { db: {}, tenantId: "t_demo" };
	const load = async () => [fakeTool];
	return new McpServer(load as never, ctx);
}

describe("MCP protocol", () => {
	it("toMcpTool 把 agent 工具转成 MCP 工具描述", () => {
		const t = toMcpTool(fakeTool);
		expect(t.name).toBe("mcp_help_sale_echo");
		expect(t.description).toBe("原样返回参数");
		expect((t.inputSchema as { properties: unknown }).properties).toBeDefined();
	});

	it("initialize 返回协议版本与 serverInfo", async () => {
		const s = makeServer();
		const resp = await s.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, "t_demo");
		expect(resp.result).toMatchObject({
			protocolVersion: expect.any(String),
			serverInfo: { name: "help-sale-mcp" },
		});
	});

	it("tools/list 返回工具列表", async () => {
		const s = makeServer();
		const resp = await s.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }, "t_demo");
		expect(resp.result).toMatchObject({ tools: [{ name: "mcp_help_sale_echo" }] });
	});

	it("tools/call 执行工具并返回文本结果", async () => {
		const s = makeServer();
		const resp = await s.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "mcp_help_sale_echo", arguments: { text: "hi" } } }, "t_demo");
		expect(resp.result).toMatchObject({ content: [{ type: "text", text: "hi" }] });
	});

	it("tools/call 未知工具返回 ToolNotFound", async () => {
		const s = makeServer();
		const resp = await s.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope" } }, "t_demo");
		expect(resp.error?.code).toBe(-32002);
	});

	it("未知方法返回 MethodNotFound", async () => {
		const s = makeServer();
		const resp = await s.handle({ jsonrpc: "2.0", id: 5, method: "foo/bar" }, "t_demo");
		expect(resp.error?.code).toBe(-32601);
	});
});