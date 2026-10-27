import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	type JsonRpcRequest,
	type JsonRpcResponse,
	type CallToolParams,
	type CallToolResult,
	type InitializeParams,
	type InitializeResult,
	type McpTool,
	McpErrorCodes,
} from "./types.js";

/** 一次工具调用的运行时上下文(与 external-tools 契约一致)。 */
export interface McpToolContext {
	db: unknown;
	tenantId: string;
	/** 可选:工具环境门槛所需配置 */
	webSearchApiKey?: string;
}

/** 工具加载器:按上下文动态加载工具(目录契约的 loadExternalAgentTools 包装)。 */
export type McpToolLoader = (ctx: McpToolContext) => Promise<AgentTool<any, any>[]>;

/**
 * 把现有 agent 工具(目录契约加载的 AgentTool)转成 MCP 工具描述。
 * AgentTool 的 parameters 是 TypeBox schema,兼容 JSON Schema,MCP 客户端可直接消费。
 */
/** MCP 工具命名前缀:隔离不同来源的工具,避免与客户端内置工具/其他 MCP 冲突。 */
export const MCP_TOOL_PREFIX = "mcp_help_sale_";

/** 名称规范化:MCP 协议要求工具名只含 [a-zA-Z0-9_-]。 */
function sanitizeMcpName(name: string): string {
	return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** 把现有 agent 工具(目录契约加载的 AgentTool)转成 MCP 工具描述(带前缀隔离)。 */
export function toMcpTool(tool: AgentTool<any, any>): McpTool {
	return {
		name: `${MCP_TOOL_PREFIX}${sanitizeMcpName(tool.name)}`,
		description: tool.description,
		inputSchema: (tool.parameters ?? { type: "object", properties: {} }) as Record<string, unknown>,
	};
}

/** MCP 服务器:持有工具加载器,处理 JSON-RPC 方法。 */
export class McpServer {
	private protocolVersion = "2025-06-18";
	private cachedTools: McpTool[] | null = null;

	constructor(
		private loadTools: McpToolLoader,
		private baseCtx: McpToolContext,
	) {}

	/** 工具清单:与租户无关,首次加载后缓存(描述/参数不变)。 */
	async listTools(): Promise<McpTool[]> {
		if (this.cachedTools) return this.cachedTools;
		const tools = await this.loadTools({ ...this.baseCtx, tenantId: "" });
		this.cachedTools = tools.map(toMcpTool);
		return this.cachedTools;
	}

	/** 失效缓存(工具目录变化后调用)。 */
	refresh(): void {
		this.cachedTools = null;
	}

	/** 统一 JSON-RPC 分发;tenantId 为当前请求租户。 */
	async handle(message: JsonRpcRequest, tenantId?: string): Promise<JsonRpcResponse> {
		const { id, method, params } = message;
		try {
			switch (method) {
				case "initialize": {
					const p = (params ?? {}) as InitializeParams;
					const result: InitializeResult = {
						protocolVersion: p.protocolVersion ?? this.protocolVersion,
						capabilities: { tools: { listChanged: false } },
						serverInfo: { name: "help-sale-mcp", version: "0.1.0" },
						instructions: "助销 agent 业务工具(客户查询/知识库/表格图表等)。调用 tools/call 执行,租户通过请求头 x-tenant-id 传递。",
					};
					return { jsonrpc: "2.0", id, result };
				}
				case "tools/list": {
					return { jsonrpc: "2.0", id, result: { tools: await this.listTools() } };
				}
				case "tools/call": {
					const p = (params ?? {}) as CallToolParams;
					const activeCtx: McpToolContext = { ...this.baseCtx, tenantId: tenantId ?? this.baseCtx.tenantId };
					// 每次调用按当前租户加载,保证租户隔离(工具 ctx 在构造时闭包捕获)
					const tools = await this.loadTools(activeCtx);
					// 去掉 MCP 前缀,映射回目录契约工具名
					const bareName = p.name.startsWith(MCP_TOOL_PREFIX) ? p.name.slice(MCP_TOOL_PREFIX.length) : p.name;
					const tool = tools.find((t) => t.name === bareName);
					if (!tool) {
						return { jsonrpc: "2.0", id, error: { code: McpErrorCodes.ToolNotFound, message: `工具不存在: ${p.name}` } };
					}
					try {
						const raw = await tool.execute("mcp", p.arguments ?? {}, undefined, undefined);
						const result: CallToolResult = {
							content: Array.isArray(raw.content)
								? raw.content.map((c) => {
									if (typeof c === "string") return { type: "text" as const, text: c };
									const text = (c as { type?: string; text?: string })?.text;
									return { type: "text" as const, text: typeof text === "string" ? text : JSON.stringify(c) };
								})
								: [{ type: "text", text: JSON.stringify(raw) }],
							isError: false,
						};
						return { jsonrpc: "2.0", id, result };
					} catch (error) {
						return {
							jsonrpc: "2.0",
							id,
							result: {
								content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
								isError: true,
							},
						};
					}
				}
				case "ping":
					return { jsonrpc: "2.0", id, result: {} };
				case "notifications/initialized":
					return { jsonrpc: "2.0", id, result: {} };
				default:
					return { jsonrpc: "2.0", id, error: { code: McpErrorCodes.MethodNotFound, message: `未知方法: ${method}` } };
			}
		} catch (error) {
			return {
				jsonrpc: "2.0",
				id,
				error: { code: McpErrorCodes.InternalError, message: error instanceof Error ? error.message : String(error) },
			};
		}
	}
}