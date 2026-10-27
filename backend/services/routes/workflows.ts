import type { DatabaseSync } from "node:sqlite";
import { Agent } from "@earendil-works/pi-agent-core";
import { approveWorkflow, createWorkflow, deleteWorkflow, findWorkflowBySignature, getWorkflow, listWorkflows, rejectWorkflow, updateWorkflow, type WorkflowStatus, type WorkflowRecord } from "../../integrations_pi/tables/agents/capabilities.js";
import { config } from "../../env.js";
import { LOCAL_PROVIDER_ID, createModelRegistry } from "../../integrations_pi/models.js";
import { createReflectionCase } from "../../integrations_pi/tables/analysis/reflections.js";
import { createTimelineRecorder, type TimelineRecorder } from "../timeline.js";
import { externalToolPaths, loadExternalAgentTools } from "../external-tools.js";
import { listWorkflowRuns, recordWorkflowRun, finishWorkflowRun, getWorkflowRun, type WorkflowRunRecord } from "../../integrations_pi/tables/agents/workflow-runs.js";
import type { FastifyInstance } from "fastify";
import type { RouteDeps } from "./helpers.js";

// ── 以下来自 v1 services/workflow-miner.ts(按“功能逻辑与路由同文件”内联) ──
/** 系统收口/编排类工具:不作为工作流步骤挖掘。 */
const SYSTEM_TOOLS = new Set([
	"emit_final", "emit_plan", "emit_analysis", "emit_evaluation", "emit_vehicle_plan", "emit_digest",
	"kanban", "subagents", "verify", "update_memory",
]);

/**
 * 工作流工具前缀(agent-tools.workflowTool 生成 workflow_<id12>)。
 * 工作流是「多步聚合」的粗粒度节点,与目录工具不在同一抽象层级:
 * 1) 参与子序列统计会把已沉淀的多步轨迹折叠成一个点,让细粒度组合的频次被切碎、排序失真;
 * 2) 生成 steps.tool=workflow_xxx 的工作流无法执行——runWorkflowEngine 只加载 tools/tools_system 目录工具。
 * 因此挖掘时把 workflow_ 开头的调用视为不可挖掘节点(与系统/噪声工具同等处理)。
 */
export const WORKFLOW_TOOL_PREFIX = "workflow_";

/**
 * 判定"模型侧生成的工作流工具名"—— 形如 workflow_<id 去连字符后前 12 位>,即 workflow_ + 12 个十六进制字符。
 * 不能用 startsWith("workflow_") 判定:目录工具 workflow_manage 同样以 workflow_ 开头,
 * 它是可正常执行的业务工具,既不该从挖掘里被剔除,也不该在校验里被判成"工作流不可嵌套"。
 */
export function isWorkflowToolName(name: string): boolean {
	return /^workflow_[0-9a-f]{12}$/.test(name);
}

/** 低信息/噪声工具:不作为工作流步骤(大量重复的底层数据访问)。 */
const NOISE_TOOLS = new Set(["sql", "date_tool", "browser", "computer", "redis", "txt", "excel", "ppt", "file_read"]);

/** 挖掘参数(全部来自 help-sale.config.yaml 的 workflows.mine 段)。 */
export interface MineOptions {
	days?: number;
	minWindow?: number;
	maxWindow?: number;
	minCount?: number;
	topChains?: number;
}

export interface MinedChain {
	chain: string[];
	count: number;
	sampleArgs: Array<Record<string, unknown>>;
	/** 序列签名(去重与幂等入库的唯一键) */
	signature: string;
}

export interface RefinedWorkflow {
	name: string;
	description: string;
	steps: Array<{ name: string; tool: string; params?: Record<string, unknown>; outputVar?: string }>;
}

/** 挖掘步长窗口:约束在 [2, 8] 且 min<=max,防止配置写坏导致无意义遍历。 */
function normalizeWindow(minWindow: number, maxWindow: number): { lo: number; hi: number } {
	const lo = Math.max(2, Math.min(8, Math.trunc(minWindow) || 2));
	const hi = Math.max(lo, Math.min(8, Math.trunc(maxWindow) || lo));
	return { lo, hi };
}

/**
 * 从 agent_events 挖掘高频工具调用子序列。
 * 过滤系统/噪声/工作流工具,折叠连续重复,按配置窗口滑窗聚合计数。
 * 每个 run 内同一子序列只计一次,因此 count 是「独立运行数」而非总调用次数。
 */
export function mineToolChains(db: DatabaseSync, tenantId: string, options: MineOptions = {}): MinedChain[] {
	const days = Math.min(Math.max(Math.trunc(options.days ?? config.workflowMineDays) || 14, 1), 365);
	const { lo, hi } = normalizeWindow(options.minWindow ?? config.workflowMineMinWindow, options.maxWindow ?? config.workflowMineMaxWindow);
	const minCount = Math.max(1, Math.trunc(options.minCount ?? config.workflowMineMinCount) || 2);
	const topChains = Math.max(1, Math.trunc(options.topChains ?? config.workflowMineTopChains) || 8);

	const since = new Date(Date.now() - days * 86400000).toISOString();
	const rows = db
		.prepare(
			"SELECT conversation_id, tool_name, payload_json, seq FROM agent_events WHERE tenant_id = ? AND event_type = 'tool_start' AND created_at >= ? ORDER BY conversation_id, seq",
		)
		.all(tenantId, since) as Array<{ conversation_id: string; tool_name: string | null; payload_json: string | null; seq: number }>;

	// 按运行分组:主 agent=runId/threadId,子代理=sub-<cardId>,工作流步骤=宿主 runId(由 workflowTool 传入)
	const byRun = new Map<string, Array<{ tool: string; args: Record<string, unknown> }>>();
	for (const r of rows) {
		const tool = String(r.tool_name ?? "");
		if (!tool || SYSTEM_TOOLS.has(tool) || NOISE_TOOLS.has(tool) || isWorkflowToolName(tool)) continue;
		let args: Record<string, unknown> = {};
		try { args = JSON.parse(String(r.payload_json ?? "{}")) as Record<string, unknown>; } catch { /* 忽略 */ }
		const runKey = String(r.conversation_id ?? "");
		if (!runKey) continue;
		const arr = byRun.get(runKey) ?? [];
		if (arr.length && arr[arr.length - 1].tool === tool) continue; // 折叠连续重复
		arr.push({ tool, args });
		byRun.set(runKey, arr);
	}

	const freq = new Map<string, { count: number; sampleArgs: Array<Record<string, unknown>> }>();
	for (const [, seq] of byRun) {
		if (seq.length < lo) continue;
		const seen = new Set<string>();
		for (let w = lo; w <= Math.min(hi, seq.length); w++) {
			for (let i = 0; i + w <= seq.length; i++) {
				const win = seq.slice(i, i + w);
				const key = win.map((x) => x.tool).join("→");
				if (seen.has(key)) continue;
				seen.add(key);
				const e = freq.get(key) ?? { count: 0, sampleArgs: win.map(() => ({})) };
				e.count++;
				if (e.count <= 3) for (let j = 0; j < win.length; j++) e.sampleArgs[j] = win[j].args;
				freq.set(key, e);
			}
		}
	}

	return [...freq.entries()]
		.filter(([, v]) => v.count >= minCount)
		.sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
		.slice(0, topChains)
		.map(([chain, v]) => ({ chain: chain.split("→"), count: v.count, sampleArgs: v.sampleArgs, signature: chain }));
}

function assistantText(content: unknown): string {
	if (!content) return "";
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content.map((c) => { const item = c as { text?: string }; return typeof item?.text === "string" ? item.text : ""; }).join("");
	}
	return "";
}

/** 用 LLM 把工具链提炼成友好的工作流定义(命名/描述/参数占位/outputVar)。 */
export async function refineChainToWorkflow(chain: MinedChain): Promise<RefinedWorkflow> {
	const runtime = createModelRegistry();
	const model = runtime.models.getModel(LOCAL_PROVIDER_ID, config.modelId);
	if (!model) throw new Error(`model not found: ${LOCAL_PROVIDER_ID}/${config.modelId}`);
	const sample = chain.sampleArgs.map((args: Record<string, unknown>, i: number) => ({ step: chain.chain[i], args }));
	const prompt = `你是工作流设计师。下面是一次用户任务中 agent 连续调用的工具序列(出现 ${chain.count} 次),请把它提炼成一个可复用的工作流。
工具序列: ${chain.chain.join(" → ")}
参数示例: ${JSON.stringify(sample)}

要求只输出一个 \`\`\`json 代码块,内容是:
{
  "name": "简短中文工作流名称",
  "description": "一句话说明用途(写清业务对象与场景,便于以后被检索到)",
  "steps": [
    { "name": "步骤名", "tool": "工具名(必须来自序列)", "params": { 具体值用 {{param.字段名}} 占位,保留有意义的常量 }, "outputVar": "out1" }
  ]
}
name / description / steps[].name 默认用中文:工作流按"中文描述"索引,由中文 query 那一路召回;
若某个工作流写成英文,系统会自动按英文索引、走英文那一路召回,两种都支持,但同一个工作流不要中英混写。
不要输出其他内容。`;

	const agent = new Agent({
		sessionId: `wf-mine-${Date.now()}`,
		streamFn: runtime.streamFn,
		initialState: { systemPrompt: "", tools: [] as never, model, messages: [] },
	});
	await agent.prompt(prompt);
	const last = [...agent.state.messages].reverse().find((m: any) => m.role === "assistant") as { content?: unknown } | undefined;
	const raw = assistantText(last?.content);
	const block = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
	const jsonText = block ? block[1] : raw;
	const parsed = JSON.parse(jsonText) as RefinedWorkflow;
	if (!parsed.name || !Array.isArray(parsed.steps) || parsed.steps.length === 0) throw new Error("提炼结果缺少 name/steps");
	return parsed;
}

/** 工具存在性与结构校验的结论。 */
export interface RefineValidation {
	ok: boolean;
	errors: string[];
	steps: RefinedWorkflow["steps"];
}

/**
 * 校验提炼结果:每步工具必须是 tools/tools_system 目录里真实加载的工具,
 * 且必须落在挖掘序列内;禁止引用工作流工具(工作流不可嵌套,执行时无法解析)。
 * 只判错与规整,不替模型猜测工具名。
 */
export function validateRefinedWorkflow(refined: RefinedWorkflow, chain: MinedChain, knownTools: Set<string>): RefineValidation {
	const errors: string[] = [];
	if (!refined?.name?.trim()) errors.push("缺少工作流名称");
	if (!Array.isArray(refined?.steps) || refined.steps.length === 0) {
		return { ok: false, errors: errors.length ? errors : ["steps 为空"], steps: [] };
	}
	const allowed = new Set(chain.chain);
	const steps: RefinedWorkflow["steps"] = [];
	refined.steps.forEach((step, i) => {
		const tool = String(step?.tool ?? "").trim();
		if (!tool) { errors.push(`第 ${i + 1} 步缺少 tool`); return; }
		if (isWorkflowToolName(tool)) { errors.push(`第 ${i + 1} 步引用工作流工具「${tool}」(工作流不可嵌套执行)`); return; }
		if (!allowed.has(tool)) { errors.push(`第 ${i + 1} 步工具「${tool}」不在挖掘序列内`); return; }
		if (!knownTools.has(tool)) { errors.push(`第 ${i + 1} 步工具「${tool}」未加载(tools 目录缺少实现)`); return; }
		steps.push({
			name: String(step.name || `${i + 1}-${tool}`).slice(0, 80),
			tool,
			params: step.params ?? undefined,
			outputVar: step.outputVar ?? undefined,
		});
	});
	return { ok: errors.length === 0, errors, steps };
}

// ── 以下来自 v1 services/workflow-runner.ts(按“功能逻辑与路由同文件”内联) ──
export interface WorkflowRunParams {
	db: DatabaseSync;
	tenantId: string;
	workflow: WorkflowRecord;
	params?: Record<string, unknown>;
	/**
	 * 宿主 agent 的轨迹采集器:传入时步骤事件写入同一缓冲,由宿主统一 flush
	 * (seq 因此在一次落库里连续分配,时间线顺序真实)。runner 不负责 flush。
	 */
	recorder?: TimelineRecorder;
	/**
	 * 独立执行(HTTP /workflows/:id/run)时的轨迹归属:自建采集器并在结束时 flush,
	 * conversationId 用 workflow-<工作流id>-<runId>,与 agent 轨迹区分开。
	 */
	traceConversationId?: string;
	threadId?: string;
	/** 只校验步骤(工具可用性/参数解析),不执行、不写执行记录。 */
	dryRun?: boolean;
}

export interface WorkflowStepOutcome {
	name: string;
	tool: string;
	ok: boolean;
	summary?: string;
	error?: string;
}

export interface WorkflowRunOutcome {
	run: WorkflowRunRecord;
	steps: WorkflowStepOutcome[];
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

/**
 * 按步骤依次执行工作流:逐步调用外部工具,支持参数占位与上一步输出传递。
 * 步骤事件写入宿主轨迹(recorder 或 traceConversationId),让工作流内部链路对挖掘/复盘可见;
 * 失败时额外落一条反思案例,进入「反思改进」闭环(此前 workflow_runs 只被前端读,无人聚合)。
 */
export async function runWorkflowEngine(input: WorkflowRunParams): Promise<WorkflowRunOutcome> {
	const { db, tenantId, workflow, params = {}, recorder, traceConversationId, threadId, dryRun } = input;
	const stepsList = (workflow.steps ?? []) as WorkflowStep[];
	const tools = await loadExternalAgentTools(externalToolPaths(), { db, tenantId });
	const byName = new Map(tools.map((t) => [t.name, t]));

	if (dryRun) {
		const steps: WorkflowStepOutcome[] = stepsList.map((step, i) => {
			const name = String(step?.name || `#${i + 1}`);
			const tool = byName.get(String(step?.tool ?? ""));
			if (!tool) return { name, tool: String(step?.tool ?? ""), ok: false, error: `工具 ${step.tool} 未加载` };
			const unresolved = findUnresolvedPlaceholders(step.params ?? {}, params);
			if (unresolved.length) {
				return { name, tool: String(step.tool), ok: false, error: `占位符未传值:${unresolved.join(", ")}(运行时会把字面量传给工具)` };
			}
			return { name, tool: String(step.tool), ok: true, summary: "可执行(未运行)" };
		});
		const broken = steps.find((s) => !s.ok);
		const now = new Date().toISOString();
		return {
			run: {
				id: "", tenantId, workflowId: workflow.id,
				status: broken ? "failed" : "success",
				paramsJson: JSON.stringify(params),
				resultJson: JSON.stringify({ steps, dryRun: true }),
				error: broken?.error ?? null,
				createdAt: now, completedAt: now,
			} as WorkflowRunRecord,
			steps,
		};
	}

	const run = recordWorkflowRun(db, tenantId, workflow.id, params);
	// 宿主传入 recorder 时共享缓冲;否则按需自建(独立执行入口)
	const ownRecorder = !recorder && traceConversationId ? createTimelineRecorder(db, { tenantId, conversationId: traceConversationId, threadId }) : undefined;
	const sink = recorder ?? ownRecorder;
	const steps: WorkflowStepOutcome[] = [];
	const outputs: Record<string, { content: unknown; details: unknown }> = {};
	const recordStep = (eventType: "tool_start" | "tool_end", toolName: string, payload: unknown) => sink?.record(eventType, { toolName, payload });

	try {
		for (const step of stepsList) {
			const tool = byName.get(step.tool);
			if (!tool) {
				steps.push({ name: step.name, tool: step.tool, ok: false, error: `工具 ${step.tool} 未加载` });
				throw new Error(`步骤「${step.name}」的工具 ${step.tool} 不存在`);
			}
			const resolved = resolveTemplate(step.params ?? {}, { params, outputs }) as Record<string, unknown>;
			recordStep("tool_start", step.tool, resolved);
			let result: { content: Array<{ type: string; text?: string }>; details: unknown };
			try {
				result = (await tool.execute(`wf-${step.name}`, resolved)) as { content: Array<{ type: string; text?: string }>; details: unknown };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				steps.push({ name: step.name, tool: step.tool, ok: false, error: message });
				recordStep("tool_end", step.tool, { error: message, workflowStep: step.name, workflowId: workflow.id });
				throw error;
			}
			const text = (result.content ?? []).map((c) => (c && typeof c.text === "string" ? c.text : "")).join(" ").slice(0, 200);
			steps.push({ name: step.name, tool: step.tool, ok: true, summary: text });
			recordStep("tool_end", step.tool, { summary: text, workflowStep: step.name, workflowId: workflow.id });
			if (step.outputVar) outputs[step.name] = { content: result.content, details: result.details };
		}
		const finished = finishWorkflowRun(db, tenantId, run.id, { status: "success", result: { steps } });
		await ownRecorder?.flush();
		return { run: finished ?? getWorkflowRun(db, tenantId, run.id)!, steps };
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		const finished = finishWorkflowRun(db, tenantId, run.id, { status: "failed", error: msg });
		await ownRecorder?.flush().catch(() => undefined);
		try {
			createReflectionCase(db, { tenantId, caseType: "run_failed", refId: run.id, detail: { source: "workflow", workflowId: workflow.id, workflowName: workflow.name, error: msg, failedStep: steps.find((s) => !s.ok)?.name ?? null } });
		} catch { /* 反思表不可写时忽略,不影响主流程 */ }
		return { run: finished ?? getWorkflowRun(db, tenantId, run.id)!, steps };
	}
}

/** dryRun 用:找出模板里仍然残留的 {{param.x}}(调用方没传值 → 运行时会把字面量交给工具)。 */
function findUnresolvedPlaceholders(paramsTemplate: Record<string, unknown>, provided: Record<string, unknown>): string[] {
		const found: string[] = [];
	const scan = (v: unknown) => {
		if (typeof v === "string") {
			const re = /\{\{param\.([^}]+)\}\}/g;
			let m: RegExpExecArray | null;
			while ((m = re.exec(v))) {
				const name = String(m[1]).trim();
				if (provided[name] === undefined) found.push(`param.${name}`);
			}
		} else if (Array.isArray(v)) v.forEach(scan);
		else if (v && typeof v === "object") Object.values(v as Record<string, unknown>).forEach(scan);
	};
	scan(paramsTemplate);
	return [...new Set(found)];
}

// ── 以下来自 v1 services/workflow-steps.ts(按“功能逻辑与路由同文件”内联) ──
/** 工作流步骤的规范结构(runner 与校验共用)。 */
export interface WorkflowStep {
	name: string;
	tool: string;
	params?: Record<string, unknown>;
	outputVar?: string;
}

/**
 * 工作流步骤可引用的工具名集合 = tools/tools_system 目录工具。
 * 工作流工具(workflow_xxx)与 MCP 工具只存在于 agent 工具列表中,
 * runWorkflowEngine 用的是同一份目录工具表,所以它们不可作为工作流步骤。
 * 加载过程只读目录与 readme.json,不访问数据库(ctx.db 仅在执行阶段使用)。
 */
export async function loadStepToolNames(tenantId = ""): Promise<Set<string>> {
	const tools = await loadExternalAgentTools(externalToolPaths(), { db: null, tenantId });
	return new Set(tools.map((t) => t.name));
}

/** 递归收集参数里出现的全部 {{...}} 占位符表达式。 */
export function collectPlaceholders(value: unknown, acc: string[] = []): string[] {
	if (typeof value === "string") {
		const re = /\{\{([^}]+)\}\}/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(value))) acc.push(String(m[1]).trim());
	} else if (Array.isArray(value)) {
		for (const v of value) collectPlaceholders(v, acc);
	} else if (value && typeof value === "object") {
		for (const v of Object.values(value as Record<string, unknown>)) collectPlaceholders(v, acc);
	}
	return acc;
}

/** 从步骤数组提取声明的 param 名(与 agent-tools.workflowParamSchema 同源规则)。 */
export function declaredParamNames(steps: WorkflowStep[]): string[] {
	const names = new Set<string>();
	for (const expr of collectPlaceholders(steps.map((s) => s.params ?? {}))) {
		if (expr.startsWith("param.")) names.add(expr.slice(6));
	}
	return [...names];
}

export interface StepCheckIssue {
	stepIndex: number;
	stepName: string;
	tool: string;
	message: string;
}

export interface StepCheckResult {
	ok: boolean;
	/** 未加载/不可用的工具 */
	unknownTools: string[];
	/** 结构或引用问题(缺步骤名、前向引用、重复步骤名等) */
	issues: StepCheckIssue[];
	paramNames: string[];
}

/**
 * 步骤静态检查(不执行):
 * 1) 每步 tool 必须在目录工具集合内(否则运行时抛「工具不存在」);
 * 2) 步骤名必须存在且不重复(resolveTemplate 以步骤名为 key,重复会互相覆盖);
 * 3) {{steps.X.*}} 必须引用更早的、且声明了 outputVar 的步骤;
 * 4) {{param.x}} 会由 workflowParamSchema 生成必填参数,列出来供调用方核对。
 */
export function checkWorkflowSteps(steps: WorkflowStep[], knownTools: Set<string>): StepCheckResult {
	const issues: StepCheckIssue[] = [];
	const unknownTools = new Set<string>();
	const seenNames = new Set<string>();
	// 步骤名 -> 是否已声明 outputVar(只有声明了 outputVar 的步骤才会被 runner 记录输出)
	const outputDeclared = new Map<string, boolean>();

	steps.forEach((step, index) => {
		const tool = String(step?.tool ?? "").trim();
		const name = String(step?.name ?? "").trim();
		if (!tool) {
			issues.push({ stepIndex: index, stepName: name || `#${index + 1}`, tool, message: "缺少 tool" });
		} else if (!knownTools.has(tool)) {
			unknownTools.add(tool);
			issues.push({ stepIndex: index, stepName: name || `#${index + 1}`, tool, message: `工具「${tool}」未加载(tools/tools_system 目录缺少实现或无 execute 导出)` });
		}
		if (!name) {
			issues.push({ stepIndex: index, stepName: `#${index + 1}`, tool, message: "缺少步骤名(参数引用与输出记录都依赖步骤名)" });
		} else if (seenNames.has(name)) {
			issues.push({ stepIndex: index, stepName: name, tool, message: "步骤名重复(后一步的输出会覆盖同名前一步)" });
		} else {
			seenNames.add(name);
			outputDeclared.set(name, Boolean(step.outputVar));
		}
		// 校验 steps.* 引用:必须指向更早声明了 outputVar 的步骤
		for (const expr of collectPlaceholders(step.params ?? {})) {
			if (!expr.startsWith("steps.")) continue;
			const refName = expr.split(".")[1] ?? "";
			if (!refName) { issues.push({ stepIndex: index, stepName: name, tool, message: `占位符 {{${expr}}} 缺少步骤名` }); continue; }
			if (seenNames.has(refName) && outputDeclared.get(refName) === false) {
				issues.push({ stepIndex: index, stepName: name, tool, message: `{{${expr}}} 引用的步骤「${refName}」未声明 outputVar,运行时无法取到输出` });
			} else if (!seenNames.has(refName)) {
				issues.push({ stepIndex: index, stepName: name, tool, message: `{{${expr}}} 引用了不存在或后置的步骤「${refName}」(只可引用更早的步骤)` });
			}
		}
	});

	return { ok: issues.length === 0, unknownTools: [...unknownTools], issues, paramNames: declaredParamNames(steps) };
}

/** 工具序列签名(与 workflow-miner 的 chainSignature 语义一致)。 */
export function stepsSignature(steps: WorkflowStep[]): string {
	return steps.map((s) => String(s?.tool ?? "").trim()).filter(Boolean).join("→");
}

// workflows 域路由(由 v1 routes/list_for_view.ts 拆分而来)

/** 工作流状态枚举白名单(请求体里的 status 字段不可信,统一过滤)。 */
function isWorkflowStatus(value: unknown): value is WorkflowStatus {
	return value === "draft" || value === "enabled" || value === "disabled" || value === "rejected";
}

export function registerWorkflowRoutes(app: FastifyInstance, deps: RouteDeps): void {
app.post<{ Body?: { days?: number; topChains?: number; refineTop?: number } }>("/api/v1/workflows/mine", async (request, reply) => {
		try {
			const body = request.body ?? {};
			const chains = mineToolChains(deps.db, request.tenantId, {
				days: body.days,
				topChains: body.topChains,
			});
			const refineTop = Math.max(0, Math.trunc(body.refineTop ?? config.workflowMineRefineTop) || 0);
			const knownTools = await loadStepToolNames(request.tenantId);
			const created: Array<{ workflow: unknown; minedFrom: string[]; count: number }> = [];
			const skipped: Array<{ signature: string; count: number; reason: string }> = [];
			for (const c of chains.slice(0, refineTop)) {
				const existing = config.workflowMineDedupe ? findWorkflowBySignature(deps.db, request.tenantId, c.signature) : undefined;
				if (existing) {
					skipped.push({ signature: c.signature, count: c.count, reason: `已存在工作流「${existing.name}」(状态:${existing.status}),跳过重复产出` });
					continue;
				}
				try {
					const refined = await refineChainToWorkflow(c);
					const check = validateRefinedWorkflow(refined, c, knownTools);
					if (!check.ok) {
						skipped.push({ signature: c.signature, count: c.count, reason: `校验未通过:${check.errors.join(";")}` });
						console.warn(`[workflows/mine] 校验未通过(${c.signature}): ${check.errors.join("; ")}`);
						continue;
					}
					const wf = createWorkflow(deps.db, request.tenantId, {
						name: refined.name,
						description: refined.description,
						steps: check.steps,
						status: "draft",
						origin: "mined",
						sourceSignature: c.signature,
					});
					created.push({ workflow: wf, minedFrom: c.chain, count: c.count });
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					skipped.push({ signature: c.signature, count: c.count, reason: `提炼失败:${message}` });
					console.warn("[workflows/mine] 提炼失败:", message);
				}
			}
			return { mined: created, skipped, totalChains: chains.length, chains };
		} catch (error) {
			return reply.code(500).send({ error: error instanceof Error ? error.message : String(error) });
		}
	});
	// origin/status 过滤:能力面板与工作流面板据此区分「模型挖掘」与「人工预定义」

app.get<{ Querystring: { origin?: string; status?: string } }>("/api/v1/workflows", async (request) => {
		const origin = request.query.origin === "mined" || request.query.origin === "manual" ? request.query.origin : undefined;
		const status = isWorkflowStatus(request.query.status) ? request.query.status : undefined;
		const all = listWorkflows(deps.db, request.tenantId);
		return { workflows: all.filter((w) => (!origin || w.origin === origin) && (!status || w.status === status)) };
	});

app.post("/api/v1/workflows", async (request, reply) => {
		const body = (request.body ?? {}) as { name?: string; description?: string; steps?: unknown[]; enabled?: boolean; status?: string; origin?: string };
		if (!body.name?.trim() || !Array.isArray(body.steps)) return reply.code(400).send({ error: "name 与 steps(步骤数组)必填" });
		// 入库前静态校验:引用不存在工具的步骤直接拒绝(否则模型调起后在该步失败)
		const knownTools = await loadStepToolNames(request.tenantId);
		const check = checkWorkflowSteps(body.steps as never, knownTools);
		if (!check.ok) return reply.code(400).send({ error: "workflow_steps_invalid", issues: check.issues, unknownTools: check.unknownTools });
		const wf = createWorkflow(deps.db, request.tenantId, {
			name: body.name,
			description: body.description,
			steps: body.steps,
			enabled: body.enabled,
			status: isWorkflowStatus(body.status) ? body.status : undefined,
			origin: body.origin === "mined" ? "mined" : "manual",
			sourceSignature: stepsSignature(body.steps as never),
		});
		return { workflow: wf, paramNames: check.paramNames };
	});
	// 晋升:草稿/已驳回 → enabled(模型轨迹变成可调用固定工作流的唯一通道)

app.post<{ Params: { id: string } }>("/api/v1/workflows/:id/approve", async (request, reply) => {
		const wf = approveWorkflow(deps.db, request.tenantId, request.params.id);
		if (!wf) return reply.code(404).send({ error: "workflow_not_found" });
		const knownTools = await loadStepToolNames(request.tenantId);
		const check = checkWorkflowSteps((wf.steps ?? []) as never, knownTools);
		return { workflow: wf, mountable: check.ok, issues: check.issues };
	});
	// 驳回:保留定义但不挂载,同时按签名阻止挖掘重复产出

app.post<{ Params: { id: string } }>("/api/v1/workflows/:id/reject", async (request, reply) => {
		const wf = rejectWorkflow(deps.db, request.tenantId, request.params.id);
		if (!wf) return reply.code(404).send({ error: "workflow_not_found" });
		return { workflow: wf };
	});
	// 静态自检(不执行、不落运行记录)

app.post<{ Params: { id: string } }>("/api/v1/workflows/:id/check", async (request, reply) => {
		const wf = getWorkflow(deps.db, request.tenantId, request.params.id);
		if (!wf) return reply.code(404).send({ error: "workflow_not_found" });
		const knownTools = await loadStepToolNames(request.tenantId);
		return { check: checkWorkflowSteps((wf.steps ?? []) as never, knownTools), status: wf.status, origin: wf.origin };
	});

app.put<{ Params: { id: string } }>("/api/v1/workflows/:id", async (request, reply) => {
		const body = (request.body ?? {}) as { name?: string; description?: string; steps?: unknown[]; enabled?: boolean; status?: string };
		if (!body.name?.trim() || !Array.isArray(body.steps)) return reply.code(400).send({ error: "name 与 steps(步骤数组)必填" });
		const knownTools = await loadStepToolNames(request.tenantId);
		const check = checkWorkflowSteps(body.steps as never, knownTools);
		if (!check.ok) return reply.code(400).send({ error: "workflow_steps_invalid", issues: check.issues, unknownTools: check.unknownTools });
		const wf = updateWorkflow(deps.db, request.tenantId, request.params.id, {
			name: body.name,
			description: body.description,
			steps: body.steps,
			enabled: body.enabled,
			status: isWorkflowStatus(body.status) ? body.status : undefined,
			sourceSignature: stepsSignature(body.steps as never),
		});
		if (!wf) return reply.code(404).send({ error: "workflow_not_found" });
		return { workflow: wf, paramNames: check.paramNames };
	});

app.delete<{ Params: { id: string } }>("/api/v1/workflows/:id", async (request, reply) => {
		const ok = deleteWorkflow(deps.db, request.tenantId, request.params.id);
		if (!ok) return reply.code(404).send({ error: "workflow_not_found" });
		return { removed: true };
	});
	// dryRun=true 时只做静态可执行性检查(工具已加载 + 占位符有值),不执行也不写执行记录

app.post<{ Params: { id: string }; Body: { params?: Record<string, unknown>; dryRun?: boolean } }>("/api/v1/workflows/:id/run", async (request, reply) => {
		const wf = getWorkflow(deps.db, request.tenantId, request.params.id);
		if (!wf) return reply.code(404).send({ error: "workflow_not_found" });
		const dryRun = request.body?.dryRun === true;
		try {
			const outcome = await runWorkflowEngine({
				db: deps.db,
				tenantId: request.tenantId,
				workflow: wf,
				params: request.body?.params ?? {},
				dryRun,
				// 独立执行(非 agent 调用)也留下步骤轨迹,供后续挖掘识别复用链路
				traceConversationId: dryRun ? undefined : `workflow-${wf.id}-${Date.now().toString(16)}`,
			});
			return { run: outcome.run, steps: outcome.steps, dryRun };
		} catch (error) {
			return reply.code(500).send({ error: error instanceof Error ? error.message : String(error) });
		}
	});
	// ── 向量检索运维(接入 Milvus 后需要可见性与重建入口) ──
	// 状态:后端是否启用、是否可达、本地/远端向量条数、未索引分块数

app.get<{ Params: { id: string } }>("/api/v1/workflows/:id/runs", async (request) => {
		return { runs: listWorkflowRuns(deps.db, request.tenantId, request.params.id) };
	});

	// ── 反思与自我改进 ──
}
