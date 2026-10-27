import { config } from "../../backend/env.js";

interface ToolContext { db: any; tenantId: string; }

const SERPER_URL = "https://google.serper.dev/search";

/** 用 Serper API 做 Google 搜索(密钥来自配置 tools.webSearch.apiKey)。 */
export async function execute(_ctx: ToolContext, params: any) {
	const q = String(params?.q ?? "").trim();
	if (!q) return { content: [{ type: "text", text: "请提供搜索关键词 q。" }] };
	const apiKey = config.webSearchApiKey;
	if (!apiKey) return { content: [{ type: "text", text: "web_search 未配置 Serper API 密钥(help-sale.config.yaml tools.webSearch.apiKey)。" }] };

	try {
		const res = await fetch(SERPER_URL, {
			method: "POST",
			headers: {
				"X-API-KEY": apiKey,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				q,
				num: Math.min(Math.max(Number(params?.num ?? 10) || 10, 1), 20),
				...(params?.gl ? { gl: String(params.gl) } : {}),
				...(params?.hl ? { hl: String(params.hl) } : {}),
			}),
		});
		if (!res.ok) {
			return { content: [{ type: "text", text: `搜索失败: HTTP ${res.status} ${res.statusText}` }], details: { status: res.status } };
		}
		const data = await res.json() as Record<string, unknown>;
		const organic = (Array.isArray(data.organic) ? data.organic : []) as Array<{ title?: string; link?: string; snippet?: string }>;
		const lines = organic.map((r, i) => `${i + 1}. ${r.title ?? ""}\n   ${r.link ?? ""}\n   ${r.snippet ?? ""}`.trim());
		return {
			content: [{ type: "text", text: lines.length ? lines.join("\n") : "未找到结果。" }],
			details: { query: q, count: organic.length, answerBox: data.answerBox ?? null, knowledgeGraph: data.knowledgeGraph ?? null },
		};
	} catch (error) {
		return { content: [{ type: "text", text: `搜索失败: ${error instanceof Error ? error.message : String(error)}` }] };
	}
}