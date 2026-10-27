/**
 * 双语 query 改写:把用户的一句话改写成 {zh, en} 两条检索词(一次模型调用)。
 *
 * 为什么要改写:目录里的工具描述中英混杂(工作流多为中文,本地工具与外部 MCP 工具是英文),
 * 而**模型自己写的一条 query 只能是一种语言** —— 中文 query 只会命中中文描述的工具,
 * 英文 query 只会命中英文描述的工具,命中就按语言分派而不是按相关度分派。
 * 改写后两条 query 各走一路召回再融合,这个矛盾就不存在了。
 *
 * 触发条件、超时、各语言召回条数、RRF 的 k 全部来自配置 tools.catalog.bilingual.*
 * (由宿主 agent-runtime 在"编目工具数超过 tools.catalog.threshold"时调用本模块)。
 */
import { Agent } from "@earendil-works/pi-agent-core";
import { createModelRegistry, requiredModel } from "../integrations_pi/models.js";
import { getQueryRewritePrompt } from "../prompts/tool-discovery.js";
import type { BilingualQuery } from "./retrieval.js";

export interface RewriteQueryOptions {
	/** 本轮可用工具总数(写进提示词,帮助模型判断该往哪种工具上找) */
	toolCount: number;
	/** 模型调用超时(毫秒):超时/解析失败都退回用户原话,不阻塞本轮 */
	timeoutMs: number;
}

/** 解析模型返回的 {"zh","en"}:容忍 ```json 代码块与前后废话 */
export function parseBilingualQuery(raw: string): BilingualQuery | undefined {
	const text = String(raw ?? "");
	const block = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
	const candidate = block ? block[1] : text;
	const jsonText = candidate.slice(candidate.indexOf("{"), candidate.lastIndexOf("}") + 1);
	if (!jsonText || jsonText.length < 2) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch {
		return undefined;
	}
	const obj = parsed as { zh?: unknown; en?: unknown };
	const zh = typeof obj?.zh === "string" ? obj.zh.trim() : "";
	const en = typeof obj?.en === "string" ? obj.en.trim() : "";
	if (!zh && !en) return undefined;
	return { zh, en };
}

function assistantText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => (typeof part === "string" ? part : typeof (part as { text?: unknown })?.text === "string" ? String((part as { text?: unknown }).text) : ""))
			.join("");
	}
	return "";
}

/**
 * 改写入口:成功返回 {zh, en};任何失败(模型不可用/超时/解析不出来)都返回 {zh: 原话, en: 原话},
 * 由调用方决定要不要用(宿主只在 catalog 模式下调用,不会被工具少的时候浪费一次模型调用)。
 */
export async function rewriteQueryBilingual(goal: string, options: RewriteQueryOptions): Promise<BilingualQuery> {
	const fallback: BilingualQuery = { zh: String(goal ?? "").trim(), en: String(goal ?? "").trim() };
	let timer: NodeJS.Timeout | undefined;
	try {
		const runtime = createModelRegistry();
		const model = requiredModel(runtime);
		const agent = new Agent({
			sessionId: `query-rewrite-${Date.now()}`,
			streamFn: runtime.streamFn,
			initialState: { systemPrompt: "", tools: [] as never, model, messages: [] },
		});
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`query rewrite timeout(${options.timeoutMs}ms)`)), Math.max(1000, options.timeoutMs));
		});
		await Promise.race([agent.prompt(getQueryRewritePrompt({ goal, toolCount: options.toolCount })), timeout]);
		const last = [...agent.state.messages].reverse().find((m: { role?: string }) => m.role === "assistant") as { content?: unknown } | undefined;
		const parsed = parseBilingualQuery(assistantText(last?.content));
		if (!parsed) {
			console.warn("[query-rewrite] 模型没返回 {zh,en},退回用户原话");
			return fallback;
		}
		// 只有一边为空时,用原话补齐缺失的那一边
		return { zh: parsed.zh || fallback.zh, en: parsed.en || fallback.en };
	} catch (error) {
		console.warn(`[query-rewrite] 改写失败,退回用户原话: ${error instanceof Error ? error.message : String(error)}`);
		return fallback;
	} finally {
		if (timer) clearTimeout(timer);
	}
}