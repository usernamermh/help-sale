import { searchVehicles } from "../../apps/api/src/repositories/vehicles.js";
import { withToolCache } from "../../apps/api/src/repositories/conversation-data.js";
import { config } from "../../apps/api/src/env.js";

interface ToolContext { db: any; tenantId: string; }

export function execute(ctx: ToolContext, params: any) {
	return withToolCache(ctx.db, ctx.tenantId, "search_vehicles", params, () => {
		const rows = searchVehicles(ctx.db, {
			tenantId: ctx.tenantId,
			budgetMin: params.budgetMin,
			budgetMax: params.budgetMax,
			seats: params.seats,
			energyType: params.energyType,
			keyword: params.keyword,
			limit: params.limit ?? config.vehicleSearchLimit,
		});
		return {
			content: [{ type: "text", text: rows.length ? rows.map((v: any) => `${v.brand} ${v.series} ${v.modelName} | ${v.priceMin}-${v.priceMax}万 | ${v.energyType}/${v.bodyType}/${v.seats}座 | ${v.highlights ?? ""}`).join("\n") : "没有匹配车型。" }],
			details: rows,
		};
	});
}