import { ingestEntries } from "../../apps/api/src/services/ingest.js";

interface ToolContext { db: any; tenantId: string; }

export function execute(ctx: ToolContext, params: any) {
	const results = ingestEntries(ctx.db, { tenantId: ctx.tenantId, category: params.category, entries: params.entries });
	const added = results.filter((r: any) => !r.skipped).length;
	return { content: [{ type: "text", text: `沉淀完成:新增 ${added} 条,跳过 ${results.length - added} 条。` }], details: results };
}