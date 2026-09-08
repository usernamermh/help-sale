import { textVector, VEC_DIM } from "../_shared/text-vec.js";

interface ToolContext { db: any; tenantId: string; }

export async function execute(_ctx: ToolContext, params: any) {
	const raw = params?.texts ?? params?.text;
	const texts = (Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [])
		.map((s: unknown) => String(s ?? ""))
		.filter((s: string) => s.trim().length > 0);
	if (texts.length === 0) return { content: [{ type: "text", text: "需要 texts(字符串数组)或 text。" }] };
	const vectors = texts.map((t) => textVector(t));
	return {
		content: [{ type: "text", text: `已生成 ${texts.length} 条向量(维度 ${VEC_DIM}),可配合 cluster 做聚类或 cosineSim 计算相似度。` }],
		details: { count: texts.length, dim: VEC_DIM, vectors },
	};
}