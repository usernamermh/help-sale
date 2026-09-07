import { listCustomers } from "../../apps/api/src/repositories/customers.js";
import { config } from "../../apps/api/src/env.js";

interface ToolContext { db: any; tenantId: string; }

const PAGE_SIZE = 10;

export function execute(ctx: ToolContext, params: any) {
	const rows = listCustomers(ctx.db, ctx.tenantId, params.limit ?? config.customersLimit);
	if (!rows.length) return { content: [{ type: "text", text: "暂无客户档案。" }], details: { customers: [], page: 1, pageSize: PAGE_SIZE, totalRows: 0, totalPages: 1, hasMore: false } };
	const page = Math.max(Number(params.page ?? 1) || 1, 1);
	const totalPages = Math.max(Math.ceil(rows.length / PAGE_SIZE), 1);
	const p = Math.min(page, totalPages);
	const slice = rows.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE);
	const lines = ["| 客户标识 | 姓名 | 电话 | 阶段 | 地区 | 意向车型 | 最近分析 | 会话数 |", "| --- | --- | --- | --- | --- | --- | --- | --- |"];
	for (const r of slice as any[]) {
		lines.push(`| ${r.key} | ${r.name ?? "—"} | ${r.phone ?? "—"} | ${r.stage ?? "—"} | ${r.region ?? "—"} | ${r.intendedVehicles?.join("、") ?? "—"} | ${r.lastAnalysisAt?.slice(0, 10) ?? "—"} | ${r.conversationCount} |`);
	}
	const footer = totalPages > 1 ? `\n(第 ${p}/${totalPages} 页 · 共 ${rows.length} 条;查看下一页请传 page=${p + 1})` : "";
	return {
		content: [{ type: "text", text: `当前客户清单(${rows.length} 位,第 ${p}/${totalPages} 页):\n${lines.join("\n")}${footer}` }],
		details: { customers: slice, rawTable: lines.join("\n"), page: p, pageSize: PAGE_SIZE, totalRows: rows.length, totalPages, hasMore: p < totalPages },
	};
}