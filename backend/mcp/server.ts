import type { FastifyInstance, FastifyRequest } from "fastify";
import { McpServer, type McpToolLoader, type McpToolContext } from "./protocol.js";
import type { JsonRpcRequest } from "./types.js";

/**
 * Streamable HTTP MCP Server 传输层(Fastify 插件)。
 * - POST /mcp:JSON-RPC 请求(标准 MCP HTTP 端点)
 * - GET  /mcp:SSE 长连接(Streamable HTTP 的 GET 建立事件流)
 * 客户端(如 Hermes/Claude Code)配置 url=http://host:3101/mcp 即可接入,凭证按租户解析规则传:
 * Authorization: Bearer <apiKey> 或 x-api-key;只有配置允许时请求头 x-tenant-id 才有效。
 *
 * 租户一律取请求上下文里的 request.tenantId(由 preHandler 按 tenant.* 配置解析),
 * 本层不自己读请求头 —— 否则等于给"绕开租户解析"留了一条旁路。
 */
export function registerMcpServer(
	app: FastifyInstance,
	ctx: McpToolContext,
	loadTools: McpToolLoader,
): McpServer {
	const server = new McpServer(loadTools, ctx);
	app.decorate("mcpServer", server);

	const handlePost = async (request: FastifyRequest, reply: any) => {
		const body = request.body as unknown;
		const msg = (Array.isArray(body) ? body[0] : body) as JsonRpcRequest | undefined;
		if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
			return reply.code(400).send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
		}
		const tenantId = request.tenantId || ctx.tenantId;
		const resp = await server.handle(msg, tenantId);
		return reply.header("content-type", "application/json").send(resp);
	};

	app.post("/mcp", handlePost);

	app.get("/mcp", async (_request, reply) => {
		reply.hijack();
		reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
		reply.raw.setHeader("Cache-Control", "no-cache");
		reply.raw.setHeader("Connection", "keep-alive");
		reply.raw.write("event: endpoint\r\ndata: /mcp\r\n\r\n");
		reply.raw.on("close", () => reply.raw.destroy());
	});

	return server;
}