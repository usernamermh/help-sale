/**
 * MCP Server 入口:把目录契约的 tools/tools_system 工具暴露为标准 MCP(Streamable HTTP)。
 * 挂载方式:在 app.ts 中调用 registerMcp(app, deps) 后,GET/POST /mcp 即对外提供 MCP 服务。
 */
import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { loadExternalAgentTools, externalToolPaths } from "../services/external-tools.js";
import { config } from "../env.js";
import { registerMcpServer } from "./server.js";
import type { McpToolContext } from "./protocol.js";

export interface McpDeps {
	db: DatabaseSync;
	tenantId: string;
}

/** 注册 MCP HTTP 端点(/mcp),工具来自 tools + tools_system 目录契约。 */
export function registerMcp(app: FastifyInstance, deps: McpDeps): void {
	const ctx: McpToolContext = { db: deps.db, tenantId: deps.tenantId, webSearchApiKey: config.webSearchApiKey };
	registerMcpServer(app, ctx, async (activeCtx) => {
		const roots = externalToolPaths();
		return loadExternalAgentTools(roots, { db: activeCtx.db, tenantId: activeCtx.tenantId, webSearchApiKey: activeCtx.webSearchApiKey });
	});
}