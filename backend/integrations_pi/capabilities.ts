import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanExternalTools, TOOL_ROOTS } from "../services/external-tools.js";
import { listWorkflows, workflowToolName, type WorkflowOrigin } from "./tables/agents/capabilities.js";

export interface CapabilityDef {
	name: string;
	label: string;
	description: string;
	category: string;
	/** 来源目录:tools(业务逻辑功能) / tools_system(系统基础能力) */
	root?: "tools" | "tools_system";
	/** 能力种类:tool=目录工具(静态) / workflow=已沉淀工作流(动态,存库) */
	kind?: "tool" | "workflow";
	/** 工作流来源:mined=模型轨迹挖掘 / manual=人工或接口预定义 */
	origin?: WorkflowOrigin;
	/** 工作流状态:draft/enabled/disabled/rejected(draft 与 rejected 对模型不可见) */
	status?: string;
	/** hidden=true 时不在能力清单展示(agent 仍可调用) */
	hidden?: boolean;
}

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * 能力清单由 tools / tools_system 目录动态生成:
 * 仅注册具备实现入口(默认 main.ts)且声明了函数(function_list / main.*)的工具,
 * 纯描述性目录(如 cluster/embedding)与未适配入口的工具不会出现。
 */
function buildCapabilities(): CapabilityDef[] {
	const out: CapabilityDef[] = [];
	for (const root of TOOL_ROOTS) {
		const rootPath = path.join(repoRoot, root);
		for (const t of scanExternalTools([rootPath])) {
			if (t.functions.length === 0) continue;
			const entry = t.entry ?? "main.ts";
			if (!existsSync(path.join(rootPath, t.dir, entry))) continue;
			out.push({
				name: t.name,
				label: t.label ?? t.name,
				description: t.description || t.name,
				category: t.category ?? "其他",
				root: t.root === "tools" ? "tools" : "tools_system",
				hidden: t.hidden === true,
			});
		}
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

export const CAPABILITIES: CapabilityDef[] = buildCapabilities();

/**
 * 动态能力:已沉淀的工作流也进能力清单,可在控制台与目录工具一起开关。
 * 名称沿用模型侧的 workflow_<id12>,开关动作直接写 workflows.status(不占 agent_capabilities),
 * 这样"停用"与"未晋升"在数据源上保持单一真相:status=enabled 才会挂给模型。
 */
export function listWorkflowCapabilities(db: DatabaseSync, tenantId: string): CapabilityDef[] {
	return listWorkflows(db, tenantId).map((w) => ({
		name: workflowToolName(w.id),
		label: "工作流:" + w.name,
		description: w.description || w.name,
		category: "工作流",
		root: undefined,
		kind: "workflow" as const,
		origin: w.origin,
		status: w.status,
		// 草稿/驳回不对模型暴露,但仍要在清单里可见(供审批入口)
		hidden: false,
	}));
}

/** 按能力名反查工作流(控制台开关用)。 */
export function findWorkflowByCapabilityName(db: DatabaseSync, tenantId: string, capabilityName: string) {
	if (!capabilityName.startsWith("workflow_")) return undefined;
	return listWorkflows(db, tenantId).find((w) => workflowToolName(w.id) === capabilityName);
}

export function capabilitiesFor(category?: string): CapabilityDef[] {
	return category ? CAPABILITIES.filter((c) => c.category === category) : CAPABILITIES;
}

export function getCapabilityDef(name: string): CapabilityDef | undefined {
	return CAPABILITIES.find((c) => c.name === name);
}

// 系统收口工具等不在目录里的展示名
const EXTRA_TOOL_LABELS: Record<string, string> = {
	emit_final: "输出最终结论",
	emit_analysis: "输出分析结论",
	emit_evaluation: "输出评估结论",
	emit_digest: "输出通话总结",
};

/**
 * 动态工作流工具的展示名缓存(工作流存在数据库里,静态 CAPABILITIES 无法预知)。
 * createSalesAgentTools 每次挂载工作流时刷新,让前端进度条显示「工作流:xxx」而不是 workflow_a1b2c3。
 */
const dynamicLabels = new Map<string, string>();

export function registerDynamicLabels(entries: Array<{ name: string; label: string }>): void {
	for (const e of entries) if (e?.name) dynamicLabels.set(e.name, e.label ?? e.name);
}

export function toolLabel(name: string | undefined): string {
	if (!name) return "未知工具";
	const dynamic = dynamicLabels.get(name);
	if (dynamic) return dynamic;
	const def = getCapabilityDef(name);
	if (def) return def.label;
	return EXTRA_TOOL_LABELS[name] ?? name;
}
