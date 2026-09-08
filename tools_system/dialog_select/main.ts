interface ToolContext { db: any; tenantId: string; }

export async function execute(_ctx: ToolContext, params: any) {
	const dialogs = Array.isArray(params?.dialogs) ? params.dialogs : [];
	if (!dialogs.length) return { content: [{ type: "text", text: "需要 dialogs(对话对象/字符串列表)。" }] };
	const keyword = String(params?.keyword ?? "").trim();
	const minLength = Math.max(0, Number(params?.minLength ?? 0) || 0);
	const maxCount = Math.max(1, Math.min(Number(params?.maxCount ?? 20) || 20, 100));
	const textOf = (d: unknown) => {
		if (typeof d === "string") return d;
		if (d && typeof d === "object") {
			const o = d as Record<string, unknown>;
			return String(o.text ?? o.content ?? o.transcript ?? "");
		}
		return "";
	};
	let picked = dialogs.map((d, index) => ({ index, text: textOf(d) }))
		.filter((x) => x.text.trim().length >= minLength)
		.filter((x) => !keyword || x.text.includes(keyword));
	picked = picked.slice(0, maxCount);
	if (!picked.length) return { content: [{ type: "text", text: keyword ? `未找到包含「${keyword}」的对话。` : "没有符合条件的对话。" }], details: { selected: [] } };
	const lines = picked.map((p) => `#${p.index + 1} ${p.text.slice(0, 80)}`);
	return {
		content: [{ type: "text", text: `已选择 ${picked.length} 段对话${keyword ? `(含「${keyword}」)` : ""}:\n${lines.join("\n")}` }],
		details: { selected: picked, keyword: keyword || undefined, minLength, maxCount },
	};
}