import { collectDigest, formatDigest } from "../../apps/api/src/services/digest.js";
import { collectInsights } from "../../apps/api/src/services/insights.js";

interface ToolContext { db: any; tenantId: string; }

export function execute(ctx: ToolContext, params: any) {
	const type = params?.type === "trend" ? "trend" : "morning";
	if (type === "morning") {
		const d = collectDigest(ctx.db, { tenantId: ctx.tenantId });
		return { content: [{ type: "text", text: formatDigest(d.stats) }], details: d };
	}
	const r = collectInsights(ctx.db, { tenantId: ctx.tenantId, days: params.days ?? undefined });
	return {
		content: [{ type: "text", text: `近${r.days}天:分析 ${r.analyses} 次 / 待办 ${r.pendingTasks} / 到期 ${r.overdueTasks} / 完成率 ${Math.round(r.taskCompletionRate * 100)}%\n热门意图:${(r.topIntents || []).map((i: any) => `${i.intent}×${i.count}`).join("、") || "无"}\n热门品牌:${(r.topBrands || []).map((b: any) => `${b.brand}×${b.count}`).join("、") || "无"}` }],
		details: r,
	};
}