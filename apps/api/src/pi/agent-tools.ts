import { Type } from "typebox";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { loadExternalAgentTools, TOOL_ROOTS } from "../services/external-tools.js";
import type { SessionStore } from "./sessions.js";

export interface SalesAgentToolDeps {
	db: DatabaseSync;
	tenantId: string;
	store: SessionStore;
}

// tools / tools_system 目录(仓库根),业务工具实现全部在目录内(main.ts + readme.json)
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const TOOL_PATHS = TOOL_ROOTS.map((r) => path.join(repoRoot, r));


/** 系统收口工具:执行计划(规划阶段输出,前端展示规划结果)。 */
export function systemPlanTool(): AgentTool<any, any> {
	return {
		name: "emit_plan",
		label: "输出执行计划",
		description: "在开始执行前,输出本次任务的执行计划:选择执行模式(mode=single 单代理自己执行 / mode=multi 多代理并行),列出步骤或多代理子任务清单。规划阶段只能调用本工具,不要执行其他工具;调用后规划阶段结束。",
		parameters: Type.Object({
			summary: Type.Optional(Type.String({ description: "规划总览一句话" })),
			mode: Type.Optional(Type.Union([Type.Literal("single"), Type.Literal("multi")], { description: "执行模式:single=单代理直接执行;multi=多代理并行(任务可并行拆分/数据量大/需多路独立取数时用 multi)" })),
			steps: Type.Array(
				Type.Object({
					step: Type.String({ description: "步骤说明" }),
					tool: Type.String({ description: "拟调用工具名(无则填空)" }),
					purpose: Type.String({ description: "预期产出/目的" }),
				}),
				{ minItems: 1 },
			),
			subtasks: Type.Optional(
				Type.Array(
					Type.Object({
						title: Type.String({ description: "子任务标题" }),
						goal: Type.String({ description: "子代理要完成的目标(独立可并行)" }),
						tools: Type.Optional(Type.Array(Type.String(), { description: "子代理可用工具白名单(缺省只读工具)" })),
					}),
					{ description: "multi 模式下的子任务清单" },
				),
			),
		}),
		async execute(_id, params: any) {
			const mode = params.mode === "multi" ? "multi" : "single";
			return {
				content: [{ type: "text" as const, text: `规划完成:${mode === "multi" ? `多代理 ${(params.subtasks ?? []).length} 个子任务` : `${(params.steps ?? []).length} 步`}` }],
				details: { summary: params.summary, mode, steps: params.steps ?? [], subtasks: params.subtasks ?? [] },
				terminate: true,
			};
		},
	};
}

/** 规划阶段工具集:仅 emit_plan(先规划不执行,避免规划阶段产生副作用)。 */
export function createPlanTools(): Array<AgentTool<any, any>> {
	return [systemPlanTool()];
}
/** 系统收口工具:最终答复(不随 tools 目录加载)。 */
export function systemFinalTool(): AgentTool<any, any> {
	return {
		name: "emit_final",
		label: "输出最终结论",
		description: "输出面向用户/销售的最终答复。完成目标后必须调用此工具并立即停止。",
		parameters: Type.Object({
			answer: Type.String({ description: "给用户的自然语言答复,允许分点与列表,但禁止包含任何 Markdown 表格(表格由工具返回,前端原样渲染)" }),
			summary: Type.Optional(Type.String({ description: "一句话摘要" })),
			nextSteps: Type.Optional(Type.Array(Type.String())),
		}),
		async execute(_id, params: any) {
			return {
				content: [{ type: "text" as const, text: params.answer }],
				details: { answer: params.answer, summary: params.summary, nextSteps: params.nextSteps ?? [] },
				terminate: true,
			};
		},
	};
}

/**
 * 从 tools / tools_system 目录动态加载全部业务工具(契约:readme.json + main.ts 导出 execute(ctx, params)),
 * 附加系统收口工具 emit_final。目录内新增/修改工具后重启服务即生效。
 */
export async function createSalesAgentTools(deps: SalesAgentToolDeps): Promise<Array<AgentTool<any, any>>> {
	const external = await loadExternalAgentTools(TOOL_PATHS, { db: deps.db, tenantId: deps.tenantId });
	return [...external, systemFinalTool()];
}