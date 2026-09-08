import { parseTranscript } from "../../apps/api/src/services/conversation.js";

interface ToolContext { db: any; tenantId: string; }

export async function execute(_ctx: ToolContext, params: any) {
	const transcript = String(params?.transcript ?? params?.text ?? "").trim();
	if (!transcript) return { content: [{ type: "text", text: "需要 transcript(带角色标注的对话文本,如「客户:…」「销售:…」)。" }] };
	const messages = parseTranscript(transcript);
	if (!messages.length) return { content: [{ type: "text", text: "未解析到对话内容。" }], details: { messages: [] } };
	const lines = messages.map((m, i) => `${i + 1}. [${m.role}] ${m.content}`);
	return {
		content: [{ type: "text", text: `已抽取 ${messages.length} 句对话原文:\n${lines.join("\n")}` }],
		details: { count: messages.length, messages },
	};
}