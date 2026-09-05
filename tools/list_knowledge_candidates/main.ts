import { listCandidates } from "../../apps/api/src/repositories/knowledge-candidates.js";
import { config } from "../../apps/api/src/env.js";

interface ToolContext { db: any; tenantId: string; }

export function execute(ctx: ToolContext, params: any) {
	const items = listCandidates(ctx.db, ctx.tenantId, "pending", params.limit ?? config.agentListLimit);
	return { content: [{ type: "text", text: items.length ? items.map((c: any) => `${c.id.slice(0, 10)}… [${c.intent}] ${c.draftTitle}: ${c.draftContent.slice(0, 120)}`).join("\n") : "暂无待沉淀候选。" }], details: items };
}