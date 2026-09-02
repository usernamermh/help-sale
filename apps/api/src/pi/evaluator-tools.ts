import { Type } from "typebox";
import type { DatabaseSync } from "node:sqlite";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { searchKnowledge } from "../repositories/knowledge.js";

export interface EvaluationDetails {
	score: number;
	dimensions: { empathy: number; structure: number; value: number; compliance: number; close: number };
	strengths: string[];
	improvements: string[];
	suggestedReply: string;
}

export function createEvaluatorTools(deps: { db: DatabaseSync; tenantId: string }): Array<AgentTool<any, any>> {
	const { db, tenantId } = deps;

	const searchTool: AgentTool<any, any> = {
		name: "search_playbook",
		label: "检索团队话术库",
		description: "在团队知识库中检索与当前场景相关的话术/政策,作为评估基准;无命中时如实说明。",
		parameters: Type.Object({ query: Type.String({ description: "检索关键词或客户原话" }) }),
		async execute(_toolCallId, params: any) {
			const hits = searchKnowledge(db, tenantId, params.query, 5);
			return {
				content: [
					{ type: "text", text: hits.length ? hits.map((h) => `【${h.title}】${h.snippet}`).join("\n\n") : "知识库无命中" },
				],
				details: hits,
			};
		},
	};

	const emitTool: AgentTool<any, any> = {
		name: "emit_evaluation",
		label: "输出评估结论",
		description: "输出话术评估的结构化结论,作为最终结果。调用后立即停止。",
		parameters: Type.Object({
			score: Type.Number({ description: "综合分 0-100" }),
			dimensions: Type.Object({
				empathy: Type.Number(),
				structure: Type.Number(),
				value: Type.Number(),
				compliance: Type.Number(),
				close: Type.Number(),
			}),
			strengths: Type.Array(Type.String(), { minItems: 1 }),
			improvements: Type.Array(Type.String(), { minItems: 1 }),
			suggestedReply: Type.String({ description: "改进后可完整复制的回复话术" }),
		}),
		async execute(_toolCallId, params: any) {
			return {
				content: [{ type: "text", text: `评估完成:${params.score} 分` }],
				details: params as EvaluationDetails,
				terminate: true,
			};
		},
	};

	return [searchTool, emitTool];
}