import { listCustomers } from "../../apps/api/src/repositories/customers.js";
import { config } from "../../apps/api/src/env.js";

interface ToolContext { db: any; tenantId: string; }

export function execute(ctx: ToolContext, params: any) {
	const rows = listCustomers(ctx.db, ctx.tenantId, params.limit ?? config.customersLimit);
	if (!rows.length) return { content: [{ type: "text", text: "暂无客户档案。" }], details: rows };
	const lines = ["| 客户标识 | 姓名 | 电话 | 阶段 | 地区 | 意向车型 | 最近分析 | 会话数 |", "| --- | --- | --- | --- | --- | --- | --- | --- |"];
	for (const r of rows as any[]) {
		lines.push(`| ${r.key} | ${r.name ?? "—"} | ${r.phone ?? "—"} | ${r.stage ?? "—"} | ${r.region ?? "—"} | ${r.intendedVehicles?.join("、") ?? "—"} | ${r.lastAnalysisAt?.slice(0, 10) ?? "—"} | ${r.conversationCount} |`);
	}
	return { content: [{ type: "text", text: `当前客户清单(${rows.length} 位):\n${lines.join("\n")}` }], details: { customers: rows, rawTable: lines.join("\n") } };
}