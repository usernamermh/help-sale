import { Type } from "typebox";
import type { DatabaseSync } from "node:sqlite";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { externalToolByName, externalToolPaths } from "../services/external-tools.js";

export interface EvaluationDetails {
	score: number;
	dimensions: { empathy: number; structure: number; value: number; compliance: number; close: number };
	strengths: string[];
	improvements: string[];
	suggestedReply: string;
}

/** 系统收口工具:输出评估结论(不随 tools 目录加载)。 */
export function emitEvaluationTool(): AgentTool<any, any> {
	return {
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
				content: [{ type: "text" as const, text: `评估完成:${params.score} 分` }],
				details: params as EvaluationDetails,
				terminate: true,
			};
		},
	};
}

/** 话术评估工具:search_playbook 来自 tools 目录,emit_evaluation 系统收口。 */
export async function createEvaluatorTools(deps: { db: DatabaseSync; tenantId: string }): Promise<Array<AgentTool<any, any>>> {
	const search = await externalToolByName(externalToolPaths(), { db: deps.db, tenantId: deps.tenantId }, "search_playbook");
	return [search, emitEvaluationTool()];
}