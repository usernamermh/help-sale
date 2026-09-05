import { resolveCustomerByKeyOrName } from "../../apps/api/src/services/customer-resolve.js";
import { listCustomerTags } from "../../apps/api/src/repositories/customer-tags.js";

interface ToolContext { db: any; tenantId: string; }

export function execute(ctx: ToolContext, params: any) {
	const row = resolveCustomerByKeyOrName(ctx.db, ctx.tenantId, params.customerKey);
	const tags = listCustomerTags(ctx.db, ctx.tenantId, row.id);
	return { content: [{ type: "text", text: tags.length ? tags.map((t: any) => `${t.tag} ×${t.weight}`).join("、") : "暂无标签。" }], details: { customerKey: row.key, tags } };
}