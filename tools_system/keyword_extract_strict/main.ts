interface ToolContext { db: any; tenantId: string; }

export async function execute(_ctx: ToolContext, params: any) {
	const text = String(params?.text ?? "").trim();
	const candidates = Array.isArray(params?.candidates)
		? params.candidates.map((s: unknown) => String(s ?? "")).filter((s: string) => s.trim().length > 0)
		: [];
	if (!text || candidates.length === 0) return { content: [{ type: "text", text: "需要 text 与 candidates(候选标签列表)。" }] };
	const hits = candidates.filter((c: string) => text.includes(c));
	return {
		content: [{ type: "text", text: hits.length ? `命中标签:${hits.join("、")}` : "候选标签均未命中。" }],
		details: { hits, total: candidates.length },
	};
}