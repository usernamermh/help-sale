import type { DatabaseSync } from "node:sqlite";
import { loadExternalAgentTools, externalToolPaths } from "./external-tools.js";
import type { WorkflowRecord } from "../repositories/agent-capabilities.js";
import type { WorkflowRunRecord } from "../repositories/workflow-runs.js";
import { recordWorkflowRun, finishWorkflowRun, getWorkflowRun } from "../repositories/workflow-runs.js";

export interface WorkflowStep {
	name: string;
	tool: string;
	params?: Record<string, unknown>;
	outputVar?: string;
}

export interface WorkflowRunParams {
	db: DatabaseSync;
	tenantId: string;
	workflow: WorkflowRecord;
	params?: Record<string, unknown>;
}

export interface WorkflowRunOutcome {
	run: WorkflowRunRecord;
	steps: Array<{ name: string; tool: string; ok: boolean; summary?: string; error?: string }>;
}

/** 解析参数中的占位符:{{param.x}} / {{steps.<步骤名>.<字段>}}(字段支持 content/details)。 */
function resolveTemplate(value: unknown, ctx: { params: Record<string, unknown>; outputs: Record<string, { content: unknown; details: unknown }> }): unknown {
	if (typeof value === "string") {
		return value.replace(/{{([^}]+)}}/g, (m, expr) => {
			const key = String(expr).trim();
			if (key.startsWith("param.")) {
				const v = ctx.params[key.slice(6)];
				return v === undefined ? m : typeof v === "object" ? JSON.stringify(v) : String(v);
			}
			if (key.startsWith("steps.")) {
				const parts = key.split(".");
				const stepName = parts[1];
				const field = parts.slice(2).join(".");
				const out = ctx.outputs[stepName];
				if (!out) return m;
				if (field === "content") return JSON.stringify(out.content ?? "");
				if (field === "details") return JSON.stringify(out.details ?? {});
				if (out.details && typeof out.details === "object" && field in (out.details as Record<string, unknown>)) {
					const v = (out.details as Record<string, unknown>)[field];
					return v === undefined ? m : typeof v === "object" ? JSON.stringify(v) : String(v);
				}
				return m;
			}
			return m;
		});
	}
	if (Array.isArray(value)) return value.map((v) => resolveTemplate(v, ctx));
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const k of Object.keys(value as Record<string, unknown>)) out[k] = resolveTemplate((value as Record<string, unknown>)[k], ctx);
		return out;
	}
	return value;
}

/** 按步骤依次执行工作流:逐步调用外部工具,支持参数占位与上一步输出传递。 */
export async function runWorkflowEngine(input: WorkflowRunParams): Promise<WorkflowRunOutcome> {
	const { db, tenantId, workflow, params = {} } = input;
	const run = recordWorkflowRun(db, tenantId, workflow.id, params);
	const steps: WorkflowRunOutcome["steps"] = [];
	const outputs: Record<string, { content: unknown; details: unknown }> = {};
	const stepsList = (workflow.steps ?? []) as WorkflowStep[];
	try {
		const tools = await loadExternalAgentTools(externalToolPaths(), { db, tenantId });
		const byName = new Map(tools.map((t) => [t.name, t]));
		for (const step of stepsList) {
			const tool = byName.get(step.tool);
			if (!tool) {
				steps.push({ name: step.name, tool: step.tool, ok: false, error: `工具 ${step.tool} 未加载` });
				throw new Error(`步骤「${step.name}」的工具 ${step.tool} 不存在`);
			}
			const resolved = resolveTemplate(step.params ?? {}, { params, outputs }) as Record<string, unknown>;
			let result: { content: Array<{ type: string; text?: string }>; details: unknown };
			try {
				result = (await tool.execute(`wf-${step.name}`, resolved)) as { content: Array<{ type: string; text?: string }>; details: unknown };
			} catch (error) {
				steps.push({ name: step.name, tool: step.tool, ok: false, error: error instanceof Error ? error.message : String(error) });
				throw error;
			}
			const text = (result.content ?? []).map((c) => (c && typeof c.text === "string" ? c.text : "")).join(" ").slice(0, 200);
			steps.push({ name: step.name, tool: step.tool, ok: true, summary: text });
			if (step.outputVar) outputs[step.name] = { content: result.content, details: result.details };
		}
		const finished = finishWorkflowRun(db, tenantId, run.id, { status: "success", result: { steps } });
		return { run: finished ?? getWorkflowRun(db, tenantId, run.id)!, steps };
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		const finished = finishWorkflowRun(db, tenantId, run.id, { status: "failed", error: msg });
		return { run: finished ?? getWorkflowRun(db, tenantId, run.id)!, steps };
	}
}
