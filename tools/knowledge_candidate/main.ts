import { approveCandidate, listCandidates, rejectCandidate } from "../../apps/api/src/repositories/knowledge-candidates.js";
import { config } from "../../apps/api/src/env.js";

interface ToolContext { db: any; tenantId: string; }

export function execute(ctx: ToolContext, params: any) {
	const op = params?.op ?? "list";
	if (op === "approve") {
		const c = approveCandidate(ctx.db, ctx.tenantId, String(params.candidateId ?? ""));
		return { content: [{ type: "text", text: c ? `已入库:${c.draftTitle}` : "未找到候选。" }], details: c };
	}
	if (op === "reject") {
		const c = rejectCandidate(ctx.db, ctx.tenantId, String(params.candidateId ?? ""));
		return { content: [{ type: "text", text: c ? `已拒绝:${c.draftTitle}` : "未找到候选。" }], details: c };
	}
	const items = listCandidates(ctx.db, ctx.tenantId, "pending", params.limit ?? config.knowledgeCandidatesLimit);
	return {
		content: [{ type: "text", text: items.length ? items.map((c: any) => `${c.id.slice(0, 10)}… [${c.intent}] ${c.draftTitle}: ${c.draftContent.slice(0, 120)}`).join("\n") : "暂无待沉淀候选。" }],
		details: { candidates: items },
	};
}