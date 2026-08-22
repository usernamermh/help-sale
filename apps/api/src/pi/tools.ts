import { Type } from "typebox";
import type { DatabaseSync } from "node:sqlite";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { getCustomer, upsertCustomer } from "../repositories/customers.js";
import { searchKnowledge } from "../repositories/knowledge.js";

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

export function createCopilotTools(deps: AgentDeps): Array<AgentTool<any, any>> {
	const { db, tenantId } = deps;

	return [
		{
			name: "search_playbook",
			label: "检索团队话术库",
			description: "在团队知识库中检索与客户问题相关的话术、竞品资料、价格政策。返回前若干条命中片段;无命中时如实返回。",
			parameters: Type.Object({
				query: Type.String({ description: "检索关键词,建议用客户原话或核心议题" }),
				limit: Type.Optional(Type.Number({ default: 5, minimum: 1, maximum: 10 })),
			}),
			async execute(_toolCallId, params) {
				const hits = searchKnowledge(db, tenantId, params.query, params.limit ?? 5);
				return {
					content: [
						{
							type: "text",
							text: hits.length
								? hits.map((h) => `【${h.title}】\n${h.snippet}`).join("\n\n")
								: "知识库未命中,请如实告知用户。",
						},
					],
					details: hits,
				};
			},
		},
		{
			name: "get_customer_profile",
			label: "查看客户档案",
			description: "按客户 key 获取客户资料(名称/公司/阶段/备注),以及该客户最近的会话上下文。",
			parameters: Type.Object({
				customerKey: Type.String({ description: "客户唯一标识,如 c_001" }),
			}),
			async execute(_toolCallId, params) {
				let row = getCustomer(db, tenantId, params.customerKey);
				if (!row) {
					row = upsertCustomer(db, { tenantId, key: params.customerKey });
				}
				return {
					content: [
						{
							type: "text",
							text: `客户:${row.name ?? params.customerKey}${row.company ? ` / ${row.company}` : ""}\n阶段:${row.stage ?? "未知"}\n备注:${row.notes ?? "无"}`,
						},
					],
					details: row,
				};
			},
		},
		{
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
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: `分析完成:${params.intent}` }],
					details: params as AnalysisDetails,
					terminate: true,
				};
			},
		},
	];
}