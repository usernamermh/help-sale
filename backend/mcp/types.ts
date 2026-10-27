/**
 * MCP(Model Context Protocol)协议类型定义。
 * 只实现本项目需要的子集:initialize / tools/list / tools/call / ping。
 * 消息格式遵循 JSON-RPC 2.0。
 */

/** JSON-RPC 请求。 */
export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: number | string;
	method: string;
	params?: unknown;
}

/** JSON-RPC 响应。 */
export interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: number | string | null;
	result?: unknown;
	error?: JsonRpcError;
}

export interface JsonRpcError {
	code: number;
	message: string;
	data?: unknown;
}

/** MCP 错误码(协议标准)。 */
export const McpErrorCodes = {
	ParseError: -32700,
	InvalidRequest: -32600,
	MethodNotFound: -32601,
	InvalidParams: -32602,
	InternalError: -32603,
	// 协议级
	ToolNotFound: -32002,
	ToolExecutionFailed: -32003,
} as const;

/** initialize 请求参数。 */
export interface InitializeParams {
	protocolVersion?: string;
	capabilities?: Record<string, unknown>;
	clientInfo?: { name?: string; version?: string };
}

/** initialize 响应。 */
export interface InitializeResult {
	protocolVersion: string;
	capabilities: {
		tools?: { listChanged?: boolean };
	};
	serverInfo: { name: string; version: string };
	instructions?: string;
}

/** MCP 工具描述(与 agent 工具契约对齐)。 */
export interface McpTool {
	name: string;
	description?: string;
	inputSchema: Record<string, unknown>;
}

/** tools/call 请求参数。 */
export interface CallToolParams {
	name: string;
	arguments?: Record<string, unknown>;
}

/** 工具执行结果(文本内容)。 */
export interface CallToolResult {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
}