import { resolveCustomerByKeyOrName } from "../../apps/api/src/services/customer-resolve.js";
import { listAnalysesByCustomer } from "../../apps/api/src/repositories/analyses.js";
import { config } from "../../apps/api/src/env.js";

interface ToolContext { db: any; tenantId: string; }

export function execute(ctx: ToolContext, params: any) {
	const row = resolveCustomerByKeyOrName(ctx.db, ctx.tenantId, params.customerKey);
	const items = listAnalysesByCustomer(ctx.db, ctx.tenantId, row.id, params.limit ?? config.analysisHistoryLimit);
	return {
		content: [{ type: "text", text: items.length ? items.map((a: any) => `[${a.createdAt.slice(0, 10)}] ${a.intent}: ${a.summary}`).join("\n") : "该客户暂无历史分析。" }],
		details: { customerKey: row.key, items },
	};
}