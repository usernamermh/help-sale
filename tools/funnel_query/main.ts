import { getFunnelStats, listSilentCustomers } from "../../apps/api/src/repositories/funnel.js";

interface ToolContext { db: any; tenantId: string; }

const STAGE_LABEL: Record<string, string> = { new: "新进店", contacted: "已联系", test_drive: "试驾", quote: "报价", closed_won: "成交", closed_lost: "战败" };
const REASON_LABEL: Record<string, string> = { price: "价格", competitor: "竞品", waiting: "等车周期", disappeared: "客户消失", other: "其他" };

export function execute(ctx: ToolContext, params: any) {
	const view = params?.view === "silent" ? "silent" : "overview";
	const storeId = params?.storeId ? String(params.storeId) : undefined;
	if (view === "silent") {
		const days = Math.max(1, Math.min(Number(params?.days ?? 7) || 7, 90));
		const customers = listSilentCustomers(ctx.db, ctx.tenantId, days, storeId);
		const lines = customers.length ? customers.map((c: any) => `${c.name ?? c.key} | ${c.phone ?? "—"} | ${c.funnelStage ?? "new"}`).join("\n") : "暂无沉默客户。";
		return { content: [{ type: "text", text: `近 ${days} 天未跟进客户(${customers.length} 位):\n${lines}` }], details: { customers, days } };
	}
	const stats = getFunnelStats(ctx.db, ctx.tenantId, storeId);
	const stageLines = stats.stages.map((s: any) => `| ${STAGE_LABEL[s.stage] ?? s.stage} | ${s.count} | ${(s.share * 100).toFixed(1)}% | ${s.avgStayDays ?? "—"} 天 |`).join("\n");
	const convLines = stats.conversions.map((c: any) => `| ${c.from}→${c.to} | ${(c.rate * 100).toFixed(1)}% |`).join("\n");
	const lostLines = stats.lostReasons.length ? stats.lostReasons.map((r: any) => `| ${REASON_LABEL[r.reason] ?? r.reason} | ${r.count} |`).join("\n") : "| — | 0 |";
	const text = `销售漏斗(共 ${stats.total} 位客户):\n\n各阶段:\n| 阶段 | 数量 | 占比 | 平均停留 |\n| --- | --- | --- | --- |\n${stageLines}\n\n转化率:\n| 路径 | 转化率 |\n| --- | --- |\n${convLines}\n\n战败原因:\n| 原因 | 数量 |\n| --- | --- |\n${lostLines}`;
	return { content: [{ type: "text", text }], details: stats };
}