import { searchVehicles } from "../../apps/api/src/repositories/vehicles.js";
import { withToolCache } from "../../apps/api/src/repositories/conversation-data.js";
import { config } from "../../apps/api/src/env.js";

interface ToolContext { db: any; tenantId: string; }

const PAGE_SIZE = 10;

export function execute(ctx: ToolContext, params: any) {
	return withToolCache(ctx.db, ctx.tenantId, "vehicle_query", params, () => {
		const rows = searchVehicles(ctx.db, {
			tenantId: ctx.tenantId,
			budgetMin: params.budgetMin,
			budgetMax: params.budgetMax,
			seats: params.seats,
			energyType: params.energyType,
			bodyType: params.bodyType,
			keyword: params.keyword,
			limit: params.limit ?? config.vehicleSearchLimit,
		});
		if (!rows.length) return { content: [{ type: "text", text: "没有匹配车型。" }], details: { vehicles: [], page: 1, totalRows: 0 } };
		const page = Math.max(Number(params.page ?? 1) || 1, 1);
		const totalPages = Math.max(Math.ceil(rows.length / PAGE_SIZE), 1);
		const p = Math.min(page, totalPages);
		const slice = rows.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE);
		const lines = ["| 品牌 | 车系 | 车型 | 价格(万) | 能源 | 级别 | 座位 | 亮点 |", "| --- | --- | --- | --- | --- | --- | --- | --- |"];
		for (const v of slice as any[]) lines.push(`| ${v.brand} | ${v.series} | ${v.modelName} | ${v.priceMin}-${v.priceMax} | ${v.energyType} | ${v.bodyType} | ${v.seats} | ${v.highlights ?? "—"} |`);
		const table = lines.join("\n");
		const footer = totalPages > 1 ? `\n(第 ${p}/${totalPages} 页 · 共 ${rows.length} 条;用户要求查看更多时再传 page=${p + 1})` : "";
		return { content: [{ type: "text", text: `匹配车型(${rows.length} 款,第 ${p}/${totalPages} 页):\n${table}${footer}` }], details: { vehicles: slice, rawTable: table, page: p, pageSize: PAGE_SIZE, totalRows: rows.length, totalPages, hasMore: p < totalPages } };
	});
}