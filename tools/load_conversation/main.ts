import { getConversation } from "../../apps/api/src/repositories/conversations.js";
import { listConversationMessages } from "../../apps/api/src/repositories/conversation-data.js";

interface ToolContext { db: any; tenantId: string; }

export function execute(ctx: ToolContext, params: any) {
	const meta = getConversation(ctx.db, ctx.tenantId, params.conversationId);
	if (!meta) return { content: [{ type: "text", text: "未找到该会话。" }] };
	const rows = listConversationMessages(ctx.db, ctx.tenantId, params.conversationId);
	if (rows.length === 0) return { content: [{ type: "text", text: "会话原文为空。" }] };
	const messages = rows.map((m: any) => ({ seq: m.seq, speakerRole: m.speaker_role, speakerName: m.speaker_name, content: m.content, spokenAt: m.spoken_at }));
	const lines = messages.map((m: any) => `${m.spokenAt ?? ""}\t[${m.speakerRole === "customer" ? "客户" : m.speakerRole === "sales" ? "销售" : "其他"}${m.speakerName ? `:${m.speakerName}` : ""}]\t${m.content}`).join("\n");
	return { content: [{ type: "text", text: `会话 ${meta.id.slice(0, 10)}… 原文:\n${lines}` }], details: { conversationId: meta.id, messages } };
}