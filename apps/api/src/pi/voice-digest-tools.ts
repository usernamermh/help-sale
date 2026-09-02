import { Type } from "typebox";
import type { DatabaseSync } from "node:sqlite";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { searchKnowledge } from "../repositories/knowledge.js";

export interface VoiceDigestDetails {
	customerProfile: string;
	concerns: string[];
	progress: string;
	suggestedActions: string[];
	summary: string;
}

export function createVoiceDigestTools(deps: { db: DatabaseSync; tenantId: string }): Array<AgentTool<any, any>> {
	const { db, tenantId } = deps;
	const searchTool: AgentTool<any, any> = {
		name: "search_playbook",
		label: "检索团队话术库",
		description: "在团队知识库中检索与当前沟通场景相关的话术/政策,用于辅助判断客户阶段。",
		parameters: Type.Object({ query: Type.String({ description: "检索关键词,如 试驾/价格/售后" }) }),
		async execute(_toolCallId, params: any) {
			const hits = searchKnowledge(db, tenantId, params.query, 5);
			return {
				content: [{ type: "text", text: hits.length ? hits.map((h) => `【${h.title}】${h.snippet}`).join("\n\n") : "知识库无命中" }],
				details: hits,
			};
		},
	};
	const emitTool: AgentTool<any, any> = {
		name: "emit_digest",
		label: "输出沟通摘要",
		description: "输出本次录音/通话文字稿的结构化摘要,作为最终结果。调用后立即停止。",
		parameters: Type.Object({
			customerProfile: Type.String({ description: "客户画像(动机/预算/用途)" }),
			concerns: Type.Array(Type.String(), { minItems: 1 }),
			progress: Type.String({ description: "当前阶段与推进阻力" }),
			suggestedActions: Type.Array(Type.String(), { minItems: 3, maxItems: 5 }),
			summary: Type.String({ description: "一段话总结" }),
		}),
		async execute(_toolCallId, params: any) {
			return {
				content: [{ type: "text", text: `摘要完成:${params.summary.slice(0, 80)}` }],
				details: params as VoiceDigestDetails,
				terminate: true,
			};
		},
	};
	return [searchTool, emitTool];
}