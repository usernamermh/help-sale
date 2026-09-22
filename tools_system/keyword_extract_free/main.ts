import { Agent } from "@earendil-works/pi-agent-core";
import { createModelRegistry } from "../../apps/api/src/pi/models.js";
import { config } from "../../apps/api/src/env.js";
import { listKeywordWords, upsertKeyword } from "../../apps/api/src/repositories/keywords.js";

interface ToolContext { db: any; tenantId: string; }

/** 从模型输出中解析关键词数组(容忍 ```json 包裹、中文顿号/逗号分隔)。 */
function parseKeywords(text: string): string[] {
	let t = String(text ?? "").trim();
	t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
	const arrMatch = t.match(/\[([\s\S]*)\]/);
	if (arrMatch) {
		return arrMatch[1]
			.split(/[，,、\n]/)
			.map((s) => s.trim().replace(/^["']|["']$/g, ""))
			.filter((s) => s.length > 0);
	}
	return t.split(/[，,、\n]/).map((s) => s.trim()).filter((s) => s.length > 0);
}

export async function execute(ctx: ToolContext, params: any) {
	const text = String(params?.text ?? "").trim();
	if (!text) return { content: [{ type: "text", text: "需要 text。" }] };
	const max = Math.max(1, Math.min(Number(params?.maxKeywords ?? 5) || 5, 20));
	const referenceLimit = Math.max(1, Math.min(Number(params?.referenceLimit ?? 20) || 20, 50));

	// 参考词库前 N 个
	const reference = listKeywordWords(ctx.db, ctx.tenantId, referenceLimit);

	// LLM 参考词库挖掘
	const runtime = createModelRegistry();
	const model = runtime.models.getModel(config.modelProvider, config.modelId);
	if (!model) throw new Error(`model not found: ${config.modelProvider}/${config.modelId}`);
	const refText = reference.length ? reference.join("、") : "(词库为空)";
	const prompt = `你是关键词挖掘器。参考团队现有词库,从下面文本中挖掘最多 ${max} 个关键词。
规则:优先贴近词库风格;可以是词库中已有的词,也可以是同主题的新词;只输出 JSON 数组,不要其他内容。

现有词库:${refText}

文本:
${text.slice(0, 4000)}`;
	const agent = new Agent({
		sessionId: `kwfree-${Date.now()}`,
		streamFn: runtime.streamFn,
		initialState: { systemPrompt: "", tools: [] as never, model, messages: [] },
	});
	await agent.prompt(prompt);
	const last = [...agent.state.messages].reverse().find((m: any) => m.role === "assistant");
	const rawText = Array.isArray(last?.content)
		? (last.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("")
		: typeof last?.content === "string" ? last.content : "";
	const mined = parseKeywords(rawText).slice(0, max);

	// 自动去重入库(upsert:同关键词命中数+1)
	const saved: Array<{ keyword: string; created: boolean }> = [];
	for (const kw of mined) {
		const existing = ctx.db.prepare("SELECT id FROM keywords WHERE tenant_id = ? AND keyword = ?").get(ctx.tenantId, kw);
		upsertKeyword(ctx.db, ctx.tenantId, { keyword: kw, source: "extract_free", hitCount: 1 });
		saved.push({ keyword: kw, created: !existing });
	}

	return {
		content: [{ type: "text", text: `挖掘关键词 ${saved.length} 个(参考词库 ${reference.length} 条):${saved.map((s) => s.keyword).join("、")}` }],
		details: { keywords: saved, referenceCount: reference.length },
	};
}