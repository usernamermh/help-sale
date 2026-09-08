import { extractKeywords } from "../_shared/text-vec.js";

interface ToolContext { db: any; tenantId: string; }

export async function execute(_ctx: ToolContext, params: any) {
	const text = String(params?.text ?? "").trim();
	if (!text) return { content: [{ type: "text", text: "需要 text。" }] };
	const max = Math.max(1, Math.min(Number(params?.maxKeywords ?? 5) || 5, 20));
	const keywords = extractKeywords(text, max);
	if (!keywords.length) return { content: [{ type: "text", text: "未抽取到有效关键词。" }], details: { keywords: [] } };
	return {
		content: [{ type: "text", text: `关键词:${keywords.join("、")}` }],
		details: { keywords },
	};
}