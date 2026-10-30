import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type JsonRpcRequest, type JsonRpcResponse, type McpTool, type CallToolResult, type InitializeResult } from "./types.js";
import type { DescriptionLanguage } from "./retrieval.js";

/** 外部 MCP Server 连接配置(来自 yaml mcp.servers 段)。 */
export interface McpServerConfig {
	name: string;
	url: string;
	headers?: Record<string, string>;
	/** 访问令牌(Personal Access Token):非空时自动带 Authorization: Bearer <pat> */
	pat?: string;
}

/**
 * 外部工具列表缓存:每次构建 agent 工具都会来找一遍工具,
 * 若每次都重新握手+拉列表,远端抖动会直接拖慢(甚至拖垮测试)。
 * 按 url 缓存 5 分钟;真正调用工具时仍走实时 tools/call。
 */
const toolsCache = new Map<string, { tools: McpTool[]; at: number }>();
/** 连接失败后的退避窗口:避免每次运行都为一个连不上的外部 server 付连接超时。 */
const FAILURE_BACKOFF_MS = 5 * 60 * 1000;
const failureBackoff = new Map<string, number>();
const TOOLS_TTL_MS = 5 * 60 * 1000;

/** 中日韩表意文字:用来判断外部工具元数据里有没有中文 */
const CJK = /[\u4e00-\u9fa5]/;

/**
 * 轻量 MCP 客户端(Streamable HTTP 传输)。
 * 通过 JSON-RPC over HTTP 连接外部 MCP Server,发现工具并转发调用。
 * 无需官方 SDK(与 MCP Server 自实现同一思路)。
 */
export class McpClient {
	private protocolVersion = "2025-06-18";
	private _id = 0;
	private initialized = false;

	constructor(private cfg: McpServerConfig) {}

	private async rpc<T = unknown>(method: string, params?: unknown): Promise<T> {
		const id = ++this._id;
		const body: JsonRpcRequest = { jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) };
		// 传输层重试:外部 MCP 端点偶发连接超时/抖动(实测同一端点首次请求超时、紧接着成功),
		// 这里对"连不上"重试 3 次;HTTP 层错误(401/4xx)不重试,直接抛给调用方看原因。
		let res: Response | undefined;
		let lastError: unknown;
		for (let attempt = 1; attempt <= 3; attempt++) {
			try {
				res = await fetch(this.cfg.url, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Accept: "application/json, text/event-stream",
						...(this.cfg.pat ? { Authorization: `Bearer ${this.cfg.pat}` } : {}),
						...(this.cfg.headers ?? {}),
					},
					body: JSON.stringify(body),
					signal: AbortSignal.timeout(30000),
				});
				break;
			} catch (error) {
				lastError = error;
				if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
			}
		}
		if (!res) {
			const cause = (lastError as { cause?: { code?: string; message?: string } })?.cause;
			throw new Error(`MCP 连接失败(${this.cfg.name}): ${lastError instanceof Error ? lastError.message : String(lastError)}${cause?.code ? ` (${cause.code})` : ""}`);
		}
		if (!res.ok) {
			throw new Error(`MCP HTTP ${res.status}(${this.cfg.name}): ${res.statusText}`);
		}
		// Streamable HTTP 可能返回 SSE 流;兼容 text/event-stream 的简单解析(取 data 行)
		const raw = await res.text();
		let jsonText = raw;
		const contentType = res.headers.get("content-type") ?? "";
		if (contentType.includes("text/event-stream") || raw.trim().startsWith("event:")) {
			const dataLine = raw.split(/\r?\n/).find((l) => l.startsWith("data:"));
			jsonText = dataLine ? dataLine.slice(5).trim() : raw;
		}
		let parsed: JsonRpcResponse;
		try {
			parsed = JSON.parse(jsonText) as JsonRpcResponse;
		} catch {
			throw new Error(`MCP 响应无法解析(${this.cfg.name}): ${jsonText.slice(0, 200)}`);
		}
		if (parsed.error) {
			throw new Error(`MCP 错误(${this.cfg.name}): ${parsed.error.code} ${parsed.error.message}`);
		}
		return parsed.result as T;
	}

	/** 握手并返回服务信息(幂等,重复调用无副作用)。 */
	async initialize(): Promise<InitializeResult> {
		if (this.initialized) return { protocolVersion: this.protocolVersion, capabilities: {}, serverInfo: { name: this.cfg.name, version: "" } };
		const result = await this.rpc<InitializeResult>("initialize", {
			protocolVersion: this.protocolVersion,
			capabilities: {},
			clientInfo: { name: "help-sale-mcp-client", version: "0.1.0" },
		});
		this.initialized = true;
		// 通知服务端初始化完成(协议要求,无响应)
		void this.rpc("notifications/initialized").catch(() => undefined);
		return result;
	}

	/** 拉取外部工具列表(带缓存与失败退避)。 */
	async listTools(): Promise<McpTool[]> {
		const cached = toolsCache.get(this.cfg.url);
		if (cached && Date.now() - cached.at < TOOLS_TTL_MS) return cached.tools;
		// 失败退避:最近刚连不上的 server 不再让用户消息等着重试,改由后台预热去探活
		const blockedUntil = failureBackoff.get(this.cfg.url) ?? 0;
		if (Date.now() < blockedUntil) {
			const left = Math.ceil((blockedUntil - Date.now()) / 1000);
			throw new Error(`MCP ${this.cfg.name} 最近连接失败,${left}s 内不再尝试(后台会继续预热)`);
		}
		try {
			const tools = await this.listToolsFresh();
			toolsCache.set(this.cfg.url, { tools, at: Date.now() });
			failureBackoff.delete(this.cfg.url);
			return tools;
		} catch (error) {
			failureBackoff.set(this.cfg.url, Date.now() + FAILURE_BACKOFF_MS);
			throw error;
		}
	}

	/** 绕过缓存强制拉取(缓存过期/首连时使用)。 */
	async listToolsFresh(): Promise<McpTool[]> {
		await this.initialize();
		const result = await this.rpc<{ tools?: McpTool[] }>("tools/list");
		const tools = result.tools ?? [];
		warnOnChineseMetadata(this.cfg.name, tools);
		return tools;
	}

	/** 调用外部工具,返回文本结果。 */
	async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
		await this.initialize();
		const result = await this.rpc<CallToolResult>("tools/call", { name, arguments: args });
		return result;
	}
}

/**
 * 外部 MCP 工具元数据的语言体检。
 *
 * 本地目录工具的元数据统一用英文(检索与模型都按英文描述设计:词面通道的驼峰/单复数、语义通道的
 * bge-small-zh 对英文短语的稳定性),所以外部 server 传进来的工具也应当是英文。
 * 检出中文时不拦截(照样能用),但要在日志里点名 —— 否则"某人挂了一个中文描述的 MCP server"
 * 会表现为"检索偶尔不准"这种查不出原因的玄学问题。
 */
export function warnOnChineseMetadata(serverName: string, tools: McpTool[]): void {
	const offenders: string[] = [];
	for (const tool of tools) {
		const fields: string[] = [];
		if (CJK.test(tool.name ?? "")) fields.push("name");
		if (CJK.test(tool.description ?? "")) fields.push("description");
		if (CJK.test(JSON.stringify(tool.inputSchema ?? {}))) fields.push("inputSchema");
		if (fields.length > 0) offenders.push(`${tool.name}[${fields.join("/")}]`);
	}
	if (offenders.length === 0) return;
	console.warn(
		`[mcp-client] 外部 MCP Server「${serverName}」有 ${offenders.length}/${tools.length} 个工具元数据含中文:${offenders.slice(0, 5).join(", ")}${offenders.length > 5 ? ` 等 ${offenders.length} 个` : ""} —— 这些工具会被判为 description_language=zh,只能被"中文 query"那一路召回;若对方能提供英文元数据,召回会更稳`,
	);
}

/** MCP 工具名规范化:只留 [a-zA-Z0-9_-]。 */
function sanitizeName(name: string): string {
	return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * 把外部 MCP 工具适配成内部 AgentTool:
 * - 名称加 `mcp_{server}_` 前缀,避免与本地工具/其他 server 冲突
 * - inputSchema 直接作为 parameters(TypeBox 兼容 JSON Schema)
 * - execute 转发到远端 tools/call,结果文本化
 */
export function mcpToolToAgentTool(serverName: string, tool: McpTool, client: McpClient): AgentTool<any, any> & { descriptionLanguage?: DescriptionLanguage } {
	const fullName = `mcp_${sanitizeName(serverName)}_${sanitizeName(tool.name)}`;
	const language: DescriptionLanguage = CJK.test(`${tool.name ?? ""} ${tool.description ?? ""}`) ? "zh" : "en";
	return {
		name: fullName,
		label: tool.name,
		// 外部工具的描述语言按文本判定:中文描述会只参与"中文 query"那一路召回(而不是混进英文池抢位)
		descriptionLanguage: language,
		description: tool.description ?? `外部 MCP 工具(${serverName})`,
		parameters: (tool.inputSchema ?? { type: "object", properties: {} }) as never,
		async execute(_toolCallId, params: any) {
			const result = await client.callTool(tool.name, (params ?? {}) as Record<string, unknown>);
			const text = (result.content ?? [])
				.map((c) => (typeof c === "string" ? c : "text" in c && typeof c.text === "string" ? c.text : JSON.stringify(c)))
				.join("\n");
			if (result.isError) throw new Error(text || "外部工具执行失败");
			return { content: [{ type: "text", text: text || "(无返回)" }], details: null };
		},
	};
}

/** 工具列表缓存有效期(毫秒):后台预热按它提前刷新。 */
export const MCP_TOOLS_TTL_MS = TOOLS_TTL_MS;

/**
 * 主动刷新若干 server 的工具列表(后台预热用)。
 * 目的不是"取数据",而是把 5 分钟缓存到期后的那次网络往返挪到后台 ——
 * 否则缓存一过期,下一条用户消息就要干等一次外部 MCP 握手(实测 20 秒)。
 */
export async function refreshMcpTools(servers: McpServerConfig[]): Promise<{ ok: string[]; failed: string[] }> {
	const ok: string[] = [];
	const failed: string[] = [];
	for (const server of servers) {
		try {
			await new McpClient(server).listToolsFresh();
			failureBackoff.delete(server.url); // 后台探活成功,解除退避
			ok.push(server.name);
		} catch (error) {
			failed.push(server.name);
			console.warn(`[mcp-client] 刷新 ${server.name} 工具列表失败: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { ok, failed };
}