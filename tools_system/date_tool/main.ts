interface ToolContext { db: any; tenantId: string; }

const WEEKDAY: Record<string, number> = { "一": 0, "二": 1, "三": 2, "四": 3, "五": 4, "六": 5, "日": 6, "天": 6 };

function replaceWeekRefs(text: string, baseDate: string): string {
	const base = new Date(baseDate + "T00:00:00");
	if (Number.isNaN(base.getTime())) return text;
	const monday = new Date(base);
	monday.setDate(base.getDate() - ((base.getDay() + 6) % 7));
	const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
	let out = text.replace(/下(?:周|星期|礼拜)([一二三四五六日天])/g, (_m, ch: string) => {
		const d = new Date(monday);
		d.setDate(monday.getDate() + (WEEKDAY[ch] ?? 0) + 7);
		return `${_m}（${fmt(d)}）`;
	});
	out = out.replace(/(?<!下)(?:周|星期|礼拜)([一二三四五六日天])/g, (_m, ch: string) => {
		const d = new Date(monday);
		d.setDate(monday.getDate() + (WEEKDAY[ch] ?? 0));
		return `${_m}（${fmt(d)}）`;
	});
	out = out.replace("今天", `今天（${baseDate}）`);
	return out;
}

export function execute(_ctx: ToolContext, params: any) {
	const text = String(params?.text ?? "").trim();
	const baseDate = String(params?.baseDate ?? "").trim() || new Date().toISOString().slice(0, 10);
	if (!text) return { content: [{ type: "text", text: "需要 text。" }] };
	return { content: [{ type: "text", text: replaceWeekRefs(text, baseDate) }], details: { baseDate, input: text } };
}