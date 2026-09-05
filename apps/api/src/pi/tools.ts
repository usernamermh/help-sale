import { Type } from "typebox";
import type { DatabaseSync } from "node:sqlite";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadExternalAgentTools, TOOL_ROOTS } from "../services/external-tools.js";

export interface AgentDeps {
	db: DatabaseSync;
	tenantId: string;
}

export interface AnalysisDetails {
	intent: string;
	summary: string;
	signals: Array<{ kind: string; quote?: string; note: string }>;
	suggestedReply: string;
	nextSteps: string[];
	followupAt?: string;
}

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const TOOL_PATHS = TOOL_ROOTS.map((r) => path.join(repoRoot, r));

const COPIOT_EXTERNAL = new Set(["search_playbook", "get_customer_profile"]);

/** 系统收口工具:输出分析结论(不随 tools 目录加载)。 */
export function emitAnalysisTool(): AgentTool<any, any> {
	return {
		name: "emit_analysis",
		label: "输出分析结论",
		description: "输出本次沟通的结构化分析结论,作为本轮最终结果。调用后必须立即停止,不要再输出其他内容。",
		parameters: Type.Object({
			intent: Type.String({ description: "客户意图分类,如 价格异议/需求确认/竞品对比/流程顾虑/催促决策" }),
			summary: Type.String({ description: "两句话概括客户当前状态与关键诉求" }),
			signals: Type.Array(
				Type.Object({
					kind: Type.Union([
						Type.Literal("pain_point"),
						Type.Literal("buying_signal"),
						Type.Literal("risk"),
						Type.Literal("competitor"),
						Type.Literal("budget"),
					]),
					quote: Type.Optional(Type.String()),
					note: Type.String(),
				}),
			),
			suggestedReply: Type.String({ description: "可直接复制发送给客户的应对话术" }),
			nextSteps: Type.Array(Type.String(), { minItems: 1 }),
			followupAt: Type.Optional(Type.String({ description: "建议跟进时间,ISO 8601" })),
		}),
		async execute(_toolCallId, params: any) {
			return {
				content: [{ type: "text" as const, text: `分析完成:${params.intent}` }],
				details: params as AnalysisDetails,
				terminate: true,
			};
		},
	};
}

/** 对话分析使用的工具:外部(search_playbook/get_customer_profile) + 系统 emit_analysis。 */
export async function createCopilotTools(deps: AgentDeps): Promise<Array<AgentTool<any, any>>> {
	const external = await loadExternalAgentTools(TOOL_PATHS, { db: deps.db, tenantId: deps.tenantId });
	return [...external.filter((t) => COPIOT_EXTERNAL.has(t.name)), emitAnalysisTool()];
}