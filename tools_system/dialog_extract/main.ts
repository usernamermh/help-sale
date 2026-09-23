import { listConversationMessages } from "../../apps/api/src/repositories/conversation-data.js";
import { Agent } from "@earendil-works/pi-agent-core";
import { createModelRegistry } from "../../apps/api/src/pi/models.js";
import { config } from "../../apps/api/src/env.js";

interface ToolContext { db: any; tenantId: string; }

interface HitMessage {
	seq: number;
	role: string;
	speakerName: string | null;
	content: string;
	spokenAt: string | null;
}

/** 从模型输出中解析序号数组(容忍 ```json 包裹与杂讯)。 */
function parseIndexes(text: string): number[] {
	let t = String(text ?? "").trim();
	t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
	// 优先取方括号数组([1,3,7]);没有方括号时退化到整段文本,兼容 "1、3、7" "1 3 7" 等常见格式
	const arrMatch = t.match(/\[([\d\s,，、]+)\]/);
	const source = arrMatch ? arrMatch[1] : t;
	const nums = source.match(/\d+/g) || [];
	return [...new Set(nums.map((s) => Number(s)).filter((n) => Number.isInteger(n) && n >= 1))];
}
export async function execute(ctx: ToolContext, params: any) {
	const conversationId = String(params?.conversationId ?? "").trim();
	const standard = String(params?.standard ?? params?.criteria ?? "").trim();
	if (!conversationId || !standard) {
		return { content: [{ type: "text", text: "需要 conversationId(会话ID)与 standard(抽取标准)。" }] };
	}
	const rows = listConversationMessages(ctx.db, ctx.tenantId, conversationId);
	if (!rows.length) return { content: [{ type: "text", text: "该会话暂无原文。" }] };

	// 编号 1..N(与 seq 对齐),构造给模型的编号清单
	const numbered = rows.map((r, i) => `${i + 1}. [${r.speaker_role === "customer" ? "客户" : "销售"}] ${r.content}`);
	const runtime = createModelRegistry();
	const model = runtime.models.getModel(config.modelProvider, config.modelId);
	if (!model) throw new Error(`model not found: ${config.modelProvider}/${config.modelId}`);

	const prompt = `你是对话片段抽取器。下面是一段编号后的销售对话(1~${rows.length})。
任务:根据「抽取标准」选出所有符合条件的句子序号。
判定要求:只选明确涉及抽取标准的句子;标准未明确指向时不要扩大范围(例如只查「试驾」时,不要把一般产品对比、闲聊、价格讨论、与试驾无关的空间/配置感受算入),拿不准的句子不要选。

抽取标准:${standard}

对话:
${numbered.join("\n")}

只输出一个 JSON 数组(如 [1,3,7]),不要输出其他内容,不要转述对话原文。`;
	const agent = new Agent({
		sessionId: `extract-${Date.now()}`,
		streamFn: runtime.streamFn,
		initialState: { systemPrompt: "", tools: [] as never, model, messages: [] },
	});
	await agent.prompt(prompt);
	const last = [...agent.state.messages].reverse().find((m: any) => m.role === "assistant");
	const rawText = Array.isArray(last?.content)
		? (last.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("")
		: typeof last?.content === "string" ? last.content : "";
	const indexes = parseIndexes(rawText);

	// 按序号取原始对话(保真),越界丢弃
	const hitSet = new Set(indexes);
	const hits: HitMessage[] = rows
		.filter((r, i) => hitSet.has(i + 1))
		.map((r) => ({ seq: r.seq, role: r.speaker_role, speakerName: r.speaker_name, content: r.content, spokenAt: r.spoken_at }));
	const hitIndexes = hits.map((h) => h.seq);

	return {
		content: [{ type: "text", text: `已按标准抽取 ${hits.length} 句(序号 ${hitIndexes.join(",") || "无"}):\n${hits.map((h) => `${h.seq}. [${h.role === "customer" ? "客户" : "销售"}] ${h.content}`).join("\n") || "未命中"}` }],
		details: { conversationId, standard, hitIndexes, messages: hits },
	};
}