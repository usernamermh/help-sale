import { Agent } from "@earendil-works/pi-agent-core";
import { createModelRegistry } from "../../backend/integrations_pi/models.js";
import { config } from "../../backend/env.js";
import { listKeywords } from "../../backend/integrations_pi/tables/knowledge/keywords.js";
import { recordKeywordHit, markConversationMined, isConversationMined } from "../../backend/integrations_pi/tables/knowledge/keyword-hits.js";
import { cosineSim } from "../_shared/text-vec.js";
import { embedTextsSafe } from "../_shared/bge-embed.js";

interface ToolContext { db: any; tenantId: string; }

const DEFAULT_WINDOW = 500;
const DEFAULT_THRESHOLD = 0.45;

/** 长对话按窗口切片(可重叠,保留上下文)。 */
function sliceText(text: string, windowSize: number): string[] {
	const t = text.replace(/\r\n/g, "\n").trim();
	if (!t) return [];
	const size = Math.max(100, windowSize);
	const overlap = Math.min(80, Math.floor(size * 0.2));
	if (t.length <= size) return [t];
	const slices: string[] = [];
	let start = 0;
	while (start < t.length) {
		slices.push(t.slice(start, start + size));
		start += size - overlap;
	}
	return slices;
}

/** 从模型输出解析关键词数组。 */
function parseKeywords(text: string): string[] {
	let t = String(text ?? "").trim();
	t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
	const arrMatch = t.match(/\[([\s\S]*)\]/);
	const parts = arrMatch ? arrMatch[1] : t;
	return parts
		.split(/[，,、\n]/)
		.map((s) => s.trim().replace(/^["']|["']$/g, ""))
		.filter((s) => s.length > 0);
}

export async function execute(ctx: ToolContext, params: any) {
	const text = String(params?.text ?? "").trim();
	const candidates = Array.isArray(params?.candidates)
		? params.candidates.map((s: unknown) => String(s ?? "")).filter((s) => s.trim().length > 0)
		: [];
	if (!text || candidates.length === 0) return { content: [{ type: "text", text: "需要 text 与 candidates(候选标签列表)。" }] };
	// 对话上下文(用于会话级去重统计与已挖掘标记)
	const conversationId = String(params?.conversationId ?? "").trim() || undefined;
	const salesName = params?.salesName ? String(params.salesName).trim() : undefined;
	const customerName = params?.customerName ? String(params.customerName).trim() : undefined;
	const newOnly = params?.newOnly !== false; // 默认只处理未挖掘过的新对话
	// 已挖掘标记:newOnly 且该对话已处理过 -> 跳过,避免重复挖掘
	if (conversationId && newOnly && isConversationMined(ctx.db, ctx.tenantId, conversationId)) {
		return { content: [{ type: "text", text: "该对话已挖掘过关键词,已跳过(newOnly)。如需重新挖掘请传 newOnly=false。" }], details: { skipped: true, conversationId } };
	}
	const windowSize = Math.max(100, Number(params?.windowSize ?? DEFAULT_WINDOW) || DEFAULT_WINDOW);
	const threshold = Number(params?.threshold ?? DEFAULT_THRESHOLD) || DEFAULT_THRESHOLD;

	// 1) 长对话切片
	const slices = sliceText(text, windowSize);

	// 2) 切片与词库(候选)做相似度匹配,满足阈值的关键词进入候选集
	const candidateVecs = await embedTextsSafe(candidates);
	const sliceVecs = await embedTextsSafe(slices);
	const matched = new Set<string>();
	for (let si = 0; si < slices.length; si++) {
		for (let ci = 0; ci < candidates.length; ci++) {
			const score = cosineSim(sliceVecs[si], candidateVecs[ci]);
			if (score >= threshold) matched.add(candidates[ci]);
		}
	}

	// 无满足阈值的关键词 → 不分析
	if (matched.size === 0) {
		return { content: [{ type: "text", text: "所有对话片段与候选标签的相似度均低于阈值,跳过分析。" }], details: { slices: slices.length, matched: [], hits: [] } };
	}

	// 3) 命中的关键词送抽取模型做抽取
	const runtime = createModelRegistry();
	const model = runtime.models.getModel(config.modelProvider, config.modelId);
	if (!model) throw new Error(`model not found: ${config.modelProvider}/${config.modelId}`);
	const matchedList = [...matched];
	const prompt = `你是标签抽取器。下面文本可能包含以下候选标签(用词可能不同但含义相同):${matchedList.join("、")}
请判断文本实际涉及了哪些候选标签,只输出命中的标签 JSON 数组,不要输出其他内容。

文本:
${text.slice(0, 4000)}`;
	const agent = new Agent({
		sessionId: `kwstrict-${Date.now()}`,
		streamFn: runtime.streamFn,
		initialState: { systemPrompt: "", tools: [] as never, model, messages: [] },
	});
	await agent.prompt(prompt);
	const last = [...agent.state.messages].reverse().find((m: any) => m.role === "assistant");
	const rawText = Array.isArray(last?.content)
		? (last.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("")
		: typeof last?.content === "string" ? last.content : "";
	const extracted = parseKeywords(rawText);

	// 4) 校验抽取结果必须存在于候选
	const hits = extracted.filter((kw) => candidates.includes(kw));

	// 5) 命中回写:同一对话内去重,按(关键词 x 会话)记录明细并计数;保留词库已有分类路径
	const uniqueHits = [...new Set(hits)];
	let counted = 0;
	let deduped = 0;
	for (const kw of uniqueHits) {
		const existing = listKeywords(ctx.db, ctx.tenantId, { keyword: kw, pageSize: 1 });
		const e = existing.items[0];
				let keywordId = e?.id;
		if (!keywordId) {
			// 候选词不在词库:先按候选词创建(词库中不存在则入库),保证能记录命中
			const { upsertKeyword } = await import("../../backend/integrations_pi/tables/knowledge/keywords.js");
			const created = upsertKeyword(ctx.db, ctx.tenantId, { keyword: kw, source: "extract_strict", hitCount: 0, categoryL1: e?.categoryL1 ?? undefined, categoryL2: e?.categoryL2 ?? undefined, categoryL3: e?.categoryL3 ?? undefined });
			keywordId = created.id;
		}
		const res = recordKeywordHit(ctx.db, ctx.tenantId, { keywordId, conversationId, conversationDate: undefined, salesName, customerName });
		if (res.counted) counted++; else deduped++;
	}
	if (conversationId) markConversationMined(ctx.db, ctx.tenantId, conversationId);

	return {
		content: [{ type: "text", text: `切片 ${slices.length} 段,相似度预筛命中 ${matched.size} 个候选,最终抽取 ${uniqueHits.length} 个:(${uniqueHits.join("、") || "无"})${conversationId ? `(新增命中 ${counted},去重 ${deduped})` : ""}` }],
		details: { slices: slices.length, matched: [...matched], hits: uniqueHits, counted, deduped, threshold, conversationId },
	};
}