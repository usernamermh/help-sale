import { getConversation, listConversations } from "../../apps/api/src/repositories/conversations.js";
import { listConversationMessages } from "../../apps/api/src/repositories/conversation-data.js";
import { config } from "../../apps/api/src/env.js";

interface ToolContext { db: any; tenantId: string; }
const PAGE_SIZE = 10;

export function execute(ctx: ToolContext, params: any) {
	const view = params?.view === "load" ? "load" : "list";
	if (view === "list") {
		const list = listConversations(ctx.db, ctx.tenantId, params.limit ?? config.agentListLimit);
		return {
			content: [{ type: "text", text: list.length ? list.map((c: any) => `${c.id.slice(0, 10)}… ${c.customerName ?? c.customerKey ?? "未知客户"} | 销售:${c.salesName} | ${c.messageCount}条 | ${c.createdAt}`).join("\n") : "暂无会话。" }],
			details: { conversations: list },
		};
	}
	const conversationId = String(params.conversationId ?? "").trim();
	if (!conversationId) return { content: [{ type: "text", text: "加载对话原文需要 conversationId。" }] };
	const meta = getConversation(ctx.db, ctx.tenantId, conversationId);
	if (!meta) return { content: [{ type: "text", text: "未找到该会话。" }] };
	const rows = listConversationMessages(ctx.db, ctx.tenantId, conversationId);
	if (rows.length === 0) {
		return { content: [{ type: "text", text: "会话原文为空。" }], details: { conversationId: meta.id, messages: [], page: 1, pageSize: PAGE_SIZE, totalMessages: 0, totalPages: 0, hasMore: false } };
	}
	const all = rows.map((m: any) => ({ seq: m.seq, speakerRole: m.speaker_role, speakerName: m.speaker_name, content: m.content, spokenAt: m.spoken_at }));
	const totalPages = Math.max(Math.ceil(all.length / PAGE_SIZE), 1);
	const page = Math.max(Number(params.page ?? 1) || 1, 1);
	const p = Math.min(page, totalPages);
	const messages = all.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE);
	const lines = messages.map((m: any) => `${m.spokenAt ?? ""}\t[${m.speakerRole === "customer" ? "客户" : m.speakerRole === "sales" ? "销售" : "其他"}${m.speakerName ? `:${m.speakerName}` : ""}]\t${m.content}`).join("\n");
	const footer = totalPages > 1 ? `(第 ${p}/${totalPages} 页 · 共 ${all.length} 条;用户要求查看更多时再传 page=${p + 1})` : "";
	return {
		content: [{ type: "text", text: `会话 ${meta.id.slice(0, 10)}… 原文 ${footer}:\n${lines}` }],
		details: { conversationId: meta.id, messages, page: p, pageSize: PAGE_SIZE, totalMessages: all.length, totalPages, hasMore: p < totalPages },
	};
}