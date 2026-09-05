import { searchKnowledge } from "../../apps/api/src/repositories/knowledge.js";
import { withToolCache } from "../../apps/api/src/repositories/conversation-data.js";
import { config } from "../../apps/api/src/env.js";

interface ToolContext { db: any; tenantId: string; }

export function execute(ctx: ToolContext, params: any) {
	return withToolCache(ctx.db, ctx.tenantId, "search_playbook", params, () => {
		const hits = searchKnowledge(ctx.db, ctx.tenantId, params.query, params.limit ?? config.knowledgeSearchLimit);
		return {
			content: [{ type: "text", text: hits.length ? hits.map((h: any) => `【${h.title}】${h.category ? `(${h.category})` : ""}\n${h.snippet}`).join("\n\n") : "知识库未命中。" }],
			details: hits,
		};
	});
}