import { listCustomers, parseVehicles } from "../../apps/api/src/repositories/customers.js";
import { listAnalysesByCustomer } from "../../apps/api/src/repositories/analyses.js";
import { listCustomerTags } from "../../apps/api/src/repositories/customer-tags.js";
import { resolveCustomerByKeyOrName } from "../../apps/api/src/services/customer-resolve.js";
import { config } from "../../apps/api/src/env.js";

interface ToolContext { db: any; tenantId: string; }

const PAGE_SIZE = 10;
const VIEWS = ["list", "profile", "history", "tags"];

function customerTable(rows: any[]): string {
	const lines = ["| 客户标识 | 姓名 | 电话 | 阶段 | 地区 | 意向车型 | 最近分析 | 会话数 |", "| --- | --- | --- | --- | --- | --- | --- | --- |"];
	for (const r of rows) {
		lines.push(`| ${r.key} | ${r.name ?? "—"} | ${r.phone ?? "—"} | ${r.stage ?? "—"} | ${r.region ?? "—"} | ${r.intendedVehicles?.join("、") ?? "—"} | ${r.lastAnalysisAt?.slice(0, 10) ?? "—"} | ${r.conversationCount} |`);
	}
	return lines.join("\n");
}

export function execute(ctx: ToolContext, params: any) {
	const view = VIEWS.includes(params?.view) ? params.view : "list";
	if (view === "list") {
		const rows = listCustomers(ctx.db, ctx.tenantId, params.limit ?? config.customersLimit);
		if (!rows.length) return { content: [{ type: "text", text: "暂无客户档案。" }], details: { customers: [], page: 1, pageSize: PAGE_SIZE, totalRows: 0, totalPages: 1, hasMore: false } };
		const page = Math.max(Number(params.page ?? 1) || 1, 1);
		const totalPages = Math.max(Math.ceil(rows.length / PAGE_SIZE), 1);
		const p = Math.min(page, totalPages);
		const slice = rows.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE);
		const table = customerTable(slice);
		const footer = totalPages > 1 ? `\n(第 ${p}/${totalPages} 页 · 共 ${rows.length} 条;用户要求查看更多时再传 page=${p + 1})` : "";
		return {
			content: [{ type: "text", text: `当前客户清单(${rows.length} 位,第 ${p}/${totalPages} 页):\n${table}${footer}` }],
			details: { customers: slice, rawTable: table, page: p, pageSize: PAGE_SIZE, totalRows: rows.length, totalPages, hasMore: p < totalPages },
		};
	}
	const keyOrName = String(params.customerKey ?? params.customerName ?? "").trim();
	if (!keyOrName) return { content: [{ type: "text", text: "查询客户详情需要 customerKey(或客户姓名)。" }] };
	const row = resolveCustomerByKeyOrName(ctx.db, ctx.tenantId, keyOrName);
	if (view === "profile") {
		return {
			content: [{ type: "text", text: `客户(key=${row.key}):${row.name ?? keyOrName}${row.company ? ` / ${row.company}` : ""}\n阶段:${row.stage ?? "未知"}\n地区:${row.region ?? "未填写"}\n备注:${row.notes ?? "无"}\n电话:${row.phone ?? "未登记"}\n意向车型:${parseVehicles(row.intended_vehicles)?.join("、") ?? "未填写"}` }],
			details: row,
		};
	}
	if (view === "history") {
		const items = listAnalysesByCustomer(ctx.db, ctx.tenantId, row.id, params.limit ?? config.analysisHistoryLimit);
		return {
			content: [{ type: "text", text: items.length ? items.map((a: any) => `[${a.createdAt.slice(0, 10)}] ${a.intent}: ${a.summary}`).join("\n") : "该客户暂无历史分析。" }],
			details: { customerKey: row.key, items },
		};
	}
	const tags = listCustomerTags(ctx.db, ctx.tenantId, row.id);
	return { content: [{ type: "text", text: tags.length ? tags.map((t: any) => `${t.tag} ×${t.weight}`).join("、") : "暂无标签。" }], details: { customerKey: row.key, tags } };
}