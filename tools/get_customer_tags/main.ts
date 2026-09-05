import { getCustomer, upsertCustomer } from "../../apps/api/src/repositories/customers.js";
import { listCustomerTags } from "../../apps/api/src/repositories/customer-tags.js";

interface ToolContext { db: any; tenantId: string; }

export function execute(ctx: ToolContext, params: any) {
	let row = getCustomer(ctx.db, ctx.tenantId, params.customerKey);
	if (!row) row = upsertCustomer(ctx.db, { tenantId: ctx.tenantId, key: params.customerKey });
	const tags = listCustomerTags(ctx.db, ctx.tenantId, row.id);
	return { content: [{ type: "text", text: tags.length ? tags.map((t: any) => `${t.tag} ×${t.weight}`).join("、") : "暂无标签。" }], details: tags };
}