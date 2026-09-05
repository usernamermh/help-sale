import { collectDigest, formatDigest } from "../../apps/api/src/services/digest.js";

interface ToolContext { db: any; tenantId: string; }

export function execute(ctx: ToolContext, _params: any) {
	const d = collectDigest(ctx.db, { tenantId: ctx.tenantId });
	return { content: [{ type: "text", text: formatDigest(d.stats) }], details: d };
}