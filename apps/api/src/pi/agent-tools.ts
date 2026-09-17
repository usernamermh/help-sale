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
		description: "在开始执行前,输出本次任务的执行计划(步骤列表:做什么/拟调用工具/预期产出)。规划阶段只能调用本工具,不要执行其他工具;调用后规划阶段结束。",
		parameters: Type.Object({
			summary: Type.Optional(Type.String({ description: "规划总览一句话" })),
			steps: Type.Array(
				Type.Object({
					step: Type.String({ description: "步骤说明" }),
					tool: Type.String({ description: "拟调用工具名(无则填空)" }),
					purpose: Type.String({ description: "预期产出/目的" }),
				}),
				{ minItems: 1 },
			),
		}),
		async execute(_id, params: any) {
			return {
				content: [{ type: "text" as const, text: `规划完成:${(params.steps ?? []).length} 步` }],
				details: { summary: params.summary, steps: params.steps ?? [] },
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
			answer: Type.String({ description: "给用户的自然语言答复,可包含分点与 Markdown 表格" }),
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