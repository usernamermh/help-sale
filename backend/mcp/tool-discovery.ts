import type { AgentTool } from "@earendil-works/pi-agent-core";
import { getCallToolPrompt, getSearchToolsPrompt, getToolDetailsPrompt } from "../prompts/tool-discovery.js";
import { summarize, type ToolCatalog } from "./catalog.js";
import type { BilingualQuery } from "./retrieval.js";

/**
 * 本轮召回状态:由宿主 agent-runtime 传入的**可变**对象。
 *   catalog   —— createSalesAgentTools 写入:本轮是否进了编目模式、编目里有多少工具(决定要不要做 query 改写)
 *   bilingual —— 宿主拿到用户问题后写入的双语改写结果;search_tools 优先用它做双语召回
 */
export interface ToolRecallState {
	catalog?: { active: boolean; toolCount: number };
	bilingual?: BilingualQuery;
}

export interface ToolDiscoveryOptions {
	/** search_tools 默认返回条数(模型可用 limit 覆盖,上限受此约束) */
	topK: number;
	/** 单次运行里 get_tool_details 的调用上限,防止模型把整个目录逐个"展开" */
	maxInspect: number;
}

/**
 * 三层调用的工具封装(常驻给模型):
 *   search_tools      → 编目:一行描述,无 schema
 *   get_tool_details  → 检查:单个工具的完整 schema
 *   call_tool         → 执行:名字校验后转发到真实工具
 * 三段 description 是提示词,统一放在 backend/prompts/tool-discovery.ts,改文案不用动这里的逻辑。
 */
export function createToolDiscoveryTools(catalog: ToolCatalog, options: ToolDiscoveryOptions, recall?: ToolRecallState): Array<AgentTool<any, any>> {
	let inspected = 0;
	const promptOptions = { catalogSize: catalog.size, topK: options.topK, maxInspect: options.maxInspect };

	const searchTool: AgentTool<any, any> = {
		name: "search_tools",
		label: "检索可用工具",
		description: getSearchToolsPrompt(promptOptions),
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "自然语言描述你想做的事;检索外部工具(mcp_)时请用英文写(如 \"list pull requests\")" },
				limit: { type: "number", description: `返回条数上限(默认 ${options.topK})` },
			},
			required: ["query"],
		},
		async execute(_id: string, raw: unknown) {
			const params = (raw ?? {}) as { query?: string; limit?: number };
			const limit = Math.max(1, Math.min(Number(params?.limit ?? options.topK) || options.topK, options.topK * 2));
			// 双语召回可用时优先用它:宿主已把用户问题改写成 {zh,en},两条 query 分别只召回中/英文描述的工具。
			// 两段**分开返回**:跨语言谁更相关交给模型按描述判断(合成一条榜单只能按名字猜,实测会错)。
			const bilingual = recall?.bilingual;
			if (bilingual) {
				const grouped = await catalog.searchGrouped(bilingual, String(params?.query ?? ""));
				const render = (items: Array<{ name: string; description: string }>) => items.map((h) => `${h.name} — ${h.description}`).join("\n");
				const sections: string[] = [];
				if (grouped.zh.length) sections.push(`【中文描述的工具】\n${render(grouped.zh)}`);
				if (grouped.en.length) sections.push(`【英文描述的工具】\n${render(grouped.en)}`);
				const text = sections.length ? sections.join("\n\n") : "没有匹配的工具。可以换个说法再检索,或直接说明你想完成的任务。";
				return { content: [{ type: "text" as const, text }], details: { hits: [...grouped.zh, ...grouped.en], grouped, recall: "bilingual", query: bilingual } };
			}
			const hits = await catalog.search(String(params?.query ?? ""), limit);
			const text = hits.length
				? hits.map((h) => `${h.name} — ${h.description}`).join("\n")
				: "没有匹配的工具。可以换个说法再检索,或直接说明你想完成的任务。";
			return { content: [{ type: "text" as const, text }], details: { hits, recall: "single", query: String(params?.query ?? "") } };		},
	};

	const detailsTool: AgentTool<any, any> = {
		name: "get_tool_details",
		label: "查看工具参数",
		description: getToolDetailsPrompt(promptOptions),
		parameters: {
			type: "object",
			properties: { name: { type: "string", description: "search_tools 返回的工具名(必须完全一致)" } },
			required: ["name"],
		},
		async execute(_id: string, raw: unknown) {
			const params = (raw ?? {}) as { name?: string };
			const name = String(params?.name ?? "").trim();
			if (inspected >= options.maxInspect) {
				return { content: [{ type: "text" as const, text: `本次运行查看工具参数的次数已达上限(${options.maxInspect}),请直接用已了解的工具完成任务。` }], details: { limited: true } };
			}
			const detail = catalog.details(name);
			if (!detail) {
				return { content: [{ type: "text" as const, text: `没有名为「${name}」的工具,请先用 search_tools 确认名称。` }], details: { found: false } };
			}
			inspected++;
			return {
				content: [{ type: "text" as const, text: `${detail.name}\n${summarize(detail.description)}\n参数定义:\n${JSON.stringify(detail.parameters ?? { type: "object", properties: {} })}` }],
				details: { name: detail.name, parameters: detail.parameters },
			};
		},
	};

	const callTool: AgentTool<any, any> = {
		name: "call_tool",
		label: "执行工具",
		description: getCallToolPrompt(),
		parameters: {
			type: "object",
			properties: {
				name: { type: "string", description: "要执行的工具名" },
				arguments: { type: "object", description: "该工具的参数对象" },
			},
			required: ["name"],
		},
		async execute(toolCallId: string, raw: unknown) {
			const params = (raw ?? {}) as { name?: string; arguments?: Record<string, unknown> };
			const result = await catalog.call(String(params?.name ?? ""), (params?.arguments ?? {}) as Record<string, unknown>, toolCallId);
			// 真实工具通常已返回 { content, details };不是这种形状时统一文本化
			if (result && typeof result === "object" && "content" in result) return result as never;
			return { content: [{ type: "text" as const, text: typeof result === "string" ? result : JSON.stringify(result ?? null) }], details: result ?? null };
		},
	};

	return [searchTool, detailsTool, callTool];
}