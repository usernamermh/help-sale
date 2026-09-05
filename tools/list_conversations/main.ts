import { listConversations } from "../../apps/api/src/repositories/conversations.js";
import { config } from "../../apps/api/src/env.js";

interface ToolContext { db: any; tenantId: string; }

export function execute(ctx: ToolContext, params: any) {
	const list = listConversations(ctx.db, ctx.tenantId, params.limit ?? config.agentListLimit);
	return {
		content: [{ type: "text", text: list.length ? list.map((c: any) => `${c.id.slice(0, 10)}… ${c.customerName ?? c.customerKey ?? "未知客户"} | 销售:${c.salesName} | ${c.messageCount}条 | ${c.createdAt}`).join("\n") : "暂无会话。" }],
		details: list,
	};
}