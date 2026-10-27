import { searchKnowledge } from "../../backend/integrations_pi/tables/knowledge/documents.js";
import { withToolCache } from "../../backend/integrations_pi/tables/crm/messages.js";
import { config } from "../../backend/env.js";

interface ToolContext { db: any; tenantId: string; }

export function execute(ctx: ToolContext, params: any) {
	return withToolCache(ctx.db, ctx.tenantId, "knowledge_search", params, () => {
		const hits = searchKnowledge(ctx.db, ctx.tenantId, params.query, params.limit ?? config.knowledgeSearchLimit);
		if (!hits.length) {
			return {
				content: [{ type: "text", text: "知识库未命中;如该内容有沉淀价值,可调用 knowledge_ingest 沉淀或生成话术候选。" }],
				details: { hits: [], query: params.query },
			};
		}
		return {
			content: [{ type: "text", text: hits.map((h: any) => `【${h.title}】${h.category ? `(${h.category})` : ""}\n${h.snippet}`).join("\n\n") }],
			details: { hits, query: params.query },
		};
	});
}