import { textVector, kmeans } from "../_shared/text-vec.js";

interface ToolContext { db: any; tenantId: string; }

export async function execute(_ctx: ToolContext, params: any) {
	const raw = params?.texts ?? params?.items;
	const texts = (Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [])
		.map((s: unknown) => String(s ?? ""))
		.filter((s: string) => s.trim().length > 0);
	if (texts.length === 0) return { content: [{ type: "text", text: "需要 texts(字符串数组)。" }] };
	const k = Math.max(1, Math.min(Number(params?.k ?? 3) || 3, 10));
	const points = texts.map((t) => textVector(t));
	const { assignments, sizes } = kmeans(points, k);
	const clusters = Array.from({ length: k }, (_, i) => ({
		id: i + 1,
		size: sizes[i] ?? 0,
		samples: texts.map((t, idx) => ({ index: idx + 1, text: t })).filter((_, idx) => assignments[idx] === i).slice(0, 5),
	})).filter((c) => c.size > 0);
	const lines = clusters.map((c) => `簇${c.id}:${c.size} 条`).join(", ");
	return {
		content: [{ type: "text", text: `聚类完成:${texts.length} 条文本分为 ${clusters.length} 簇。\n${lines}` }],
		details: { count: texts.length, k: clusters.length, assignments, clusters },
	};
}