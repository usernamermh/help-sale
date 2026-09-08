import { appendMemory, memoryFilePath } from "../../apps/api/src/services/memory.js";

interface ToolContext { db: any; tenantId: string; }

export async function execute(_ctx: ToolContext, params: any) {
	const section = String(params?.section ?? "").trim();
	const content = String(params?.content ?? "").trim();
	if (!section || !content) return { content: [{ type: "text", text: "需要 section 与 content。" }] };
	if (content.length > 2000) return { content: [{ type: "text", text: "单条记忆不能超过 2000 字符。" }] };
	try {
		const updated = appendMemory(memoryFilePath(), section, content);
		return {
			content: [{ type: "text", text: `已更新记忆(${section}):${content}` }],
			details: { section, content, file: memoryFilePath(), chars: updated.length },
		};
	} catch (error) {
		return { content: [{ type: "text", text: `更新记忆失败:${error instanceof Error ? error.message : String(error)}` }] };
	}
}