import { createCandidate } from "../../apps/api/src/repositories/knowledge-candidates.js";

interface ToolContext { db: any; tenantId: string; }

/** 主 agent 发现值得沉淀/更新的话术时,生成"沉淀候选"等待二次确认(后台检索+相似度判断后审批入库)。 */
export function execute(ctx: ToolContext, params: any) {
	const entries = Array.isArray(params.entries) ? params.entries : [];
	if (!entries.length) return { content: [{ type: "text", text: "需要 entries(知识点数组,每项含 title/content)。" }] };
	const created = entries.map((e: any) => createCandidate(ctx.db, {
		tenantId: ctx.tenantId,
		analysisId: "agent",
		intent: params.category ? String(params.category) : "话术",
		draftTitle: String(e.title ?? "").trim(),
		draftContent: String(e.content ?? "").trim(),
	}));
	return {
		content: [{ type: "text", text: `已生成 ${created.length} 条沉淀候选,将由后台二次确认(新增/覆盖/跳过)后入库,可在 knowledge_candidate(op=list) 查看。` }],
		details: created,
	};
}
