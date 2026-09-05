interface ToolContext { db: any; tenantId: string; }

function extractText(html: string): { title: string; text: string } {
	const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
	const body = (/<body[^>]*>([\s\S]*?)(?:<\/body>|$)/i.exec(html)?.[1] ?? html)
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
		.replace(/\s+/g, " ")
		.trim();
	return { title, text: body };
}

export async function execute(_ctx: ToolContext, params: any) {
	const url = String(params?.url ?? "").trim();
	if (!/^https?:\/\//i.test(url)) return { content: [{ type: "text", text: "url 需以 http(s):// 开头。" }] };
	const maxChars = Math.min(Number(params?.maxChars ?? 2000) || 2000, 8000);
	try {
		const res = await fetch(url, { headers: { "user-agent": "help-sale-browser-tool/1.0" }, signal: AbortSignal.timeout(8000), redirect: "follow" });
		if (!res.ok) return { content: [{ type: "text", text: `抓取失败:HTTP ${res.status}` }] };
		const html = await res.text();
		const { title, text } = extractText(html.slice(0, 600000));
		const body = text.slice(0, maxChars);
		return { content: [{ type: "text", text: `标题:${title || "(无)"}\n正文:\n${body || "(无正文)"}` }], details: { url, title, status: res.status } };
	} catch (error) {
		return { content: [{ type: "text", text: `抓取失败:${error instanceof Error ? error.message : String(error)}` }] };
	}
}