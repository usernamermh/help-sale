import { Type } from "typebox";
import type { DatabaseSync } from "node:sqlite";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { externalToolByName, externalToolPaths } from "../services/external-tools.js";

export interface VoiceDigestDetails {
	customerProfile: string;
	concerns: string[];
	progress: string;
	suggestedActions: string[];
	summary: string;
}

/** 系统收口工具:输出沟通摘要(不随 tools 目录加载)。 */
export function emitDigestTool(): AgentTool<any, any> {
	return {
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
				content: [{ type: "text" as const, text: `摘要完成` }],
				details: params as VoiceDigestDetails,
				terminate: true,
			};
		},
	};
}

/** 通话/试驾总结工具:search_playbook 来自 tools 目录,emit_digest 系统收口。 */
export async function createVoiceDigestTools(deps: { db: DatabaseSync; tenantId: string }): Promise<Array<AgentTool<any, any>>> {
	const search = await externalToolByName(externalToolPaths(), { db: deps.db, tenantId: deps.tenantId }, "search_playbook");
	return [search, emitDigestTool()];
}