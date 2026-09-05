import { resolveCustomerByKeyOrName } from "../../apps/api/src/services/customer-resolve.js";

interface ToolContext { db: any; tenantId: string; }

export function execute(ctx: ToolContext, params: any) {
	const row = resolveCustomerByKeyOrName(ctx.db, ctx.tenantId, params.customerKey);
	return {
		content: [{ type: "text", text: `客户(key=${row.key}):${row.name ?? params.customerKey}${row.company ? ` / ${row.company}` : ""}\n阶段:${row.stage ?? "未知"}\n备注:${row.notes ?? "无"}\n电话:${row.phone ?? "未登记"}` }],
		details: row,
	};
}