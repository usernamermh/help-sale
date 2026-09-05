import { approveCandidate } from "../../apps/api/src/repositories/knowledge-candidates.js";

interface ToolContext { db: any; tenantId: string; }

export function execute(ctx: ToolContext, params: any) {
	const c = approveCandidate(ctx.db, ctx.tenantId, params.candidateId);
	return { content: [{ type: "text", text: c ? `已入库:${c.draftTitle}` : "未找到候选。" }], details: c };
}