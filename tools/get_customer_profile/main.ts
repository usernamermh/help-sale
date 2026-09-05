import { getCustomer, upsertCustomer } from "../../apps/api/src/repositories/customers.js";

interface ToolContext { db: any; tenantId: string; }

export function execute(ctx: ToolContext, params: any) {
	let row = getCustomer(ctx.db, ctx.tenantId, params.customerKey);
	if (!row) row = upsertCustomer(ctx.db, { tenantId: ctx.tenantId, key: params.customerKey });
	return {
		content: [{ type: "text", text: `客户:${row.name ?? params.customerKey}${row.company ? ` / ${row.company}` : ""}\n阶段:${row.stage ?? "未知"}\n备注:${row.notes ?? "无"}\n电话:${row.phone ?? "未登记"}` }],
		details: row,
	};
}