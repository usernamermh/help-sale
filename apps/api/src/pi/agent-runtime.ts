import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Agent, type AgentMessage, type StreamFn } from "@earendil-works/pi-agent-core";
import { createModelRegistry, type ModelRuntime } from "./models.js";
import { getSalesAgentSystemPrompt } from "../prompts/sales-agent.js";
import { createPlanTools, createSalesAgentTools } from "./agent-tools.js";
import { config } from "../env.js";
import { createTimelineRecorder } from "../services/timeline.js";
import { listCapabilityStates } from "../repositories/agent-capabilities.js";
import { recordAgentPlan, updateAgentPlan } from "../repositories/agent-plans.js";
import { toClientEvents } from "./events-adapter.js";
import { toolLabel } from "./capabilities.js";
import type { SessionStore } from "./sessions.js";

export interface SalesAgentDeps {
	db: DatabaseSync;
	tenantId: string;
	store: SessionStore;
	runtime?: ModelRuntime;
	streamFn?: StreamFn;
}

export interface AgentProgressEvent {
	type: "tool_start" | "tool_end" | "tool_update" | "plan" | "verified";
	toolCallId?: string;
	toolName?: string;
	label?: string;
	payload?: unknown;
}

export interface SalesAgentInput {
	goal: string;
	customerKey?: string;
	conversationId?: string;
	history?: AgentMessage[];
	onProgress?: (event: AgentProgressEvent) => void;
	plan?: PlanDetails; // 执行计划(注入【执行计划】上下文)
	collectExecutedTools?: boolean; // 收集本轮实际调用工具(用于验证)
}

export interface PlanStep {
	step: string;
	tool: string;
	purpose: string;
}

export interface PlanDetails {
	summary?: string;
	steps: PlanStep[];
}

export interface PlanVerification {
	planned: number;
	executed: string[];
	coveredTools: string[];
	missingTools: string[];
	summary: string;
}

export interface AgentFinal {
	answer: string;
	summary?: string;
	nextSteps: string[];
}



/**
 * 表格保真:收集本轮工具返回的原始 Markdown 表格(details.rawTable / details.table)。
 * 模型可能转述/重排表格,最终答复生成后若未包含原文,则原样追加,只允许模型在数据基础上总结。
 */
function collectRawTables(messages: unknown[]): string[] {
	const tables: string[] = [];
	for (const message of messages) {
		const m = message as { role?: string; details?: Record<string, unknown> };
		if (m.role !== "toolResult" || !m.details) continue;
		const raw =
			typeof m.details.rawTable === "string"
				? m.details.rawTable
				: typeof m.details.table === "string"
					? m.details.table
					: undefined;
		if (raw && raw.includes("|") && !tables.includes(raw)) tables.push(raw);
	}
	return tables;
}

/** 剔除 Markdown 表格:移除代码块外所有以 | 开头的行(模型自造/转述的表格一律不允许出现在答复里)。 */
/** 给模型构造历史时清理图表代码块:把 ```echarts ... ``` 替换为 [图表] 占位,避免模型复述/转义历史图表 JSON。 */
export function stripChartsForHistory(content: unknown): unknown {
	const strip = (t: string) => t.replace(/```echarts\s*\n?[\s\S]*?```/g, "[图表]");
	if (typeof content === "string") return strip(content);
	if (Array.isArray(content)) {
		return content.map((item) => {
			const c0 = item as { type?: string; text?: string };
			return c0 && typeof c0.text === "string" ? { ...c0, text: strip(c0.text) } : item;
		});
	}
	return content;
}

export function stripMarkdownTables(text: string): string {
	const lines = text.split("\n");
	const out: string[] = [];
	let inFence = false;
	for (const line of lines) {
		if (/^\s*```/.test(line)) {
			inFence = !inFence;
			out.push(line);
			continue;
		}
		if (!inFence && line.trim().startsWith("|")) continue;
		out.push(line);
	}
	return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** 图表保真:收集本轮工具返回的 ECharts 代码块(```echarts),最终答复原样追加,由前端渲染交互式图表。 */
function collectRawCharts(messages: unknown[]): string[] {
	const blocks: string[] = [];
	for (const message of messages) {
		const m = message as { role?: string; content?: unknown };
		if (m.role !== "toolResult") continue;
		const text = assistantText(m.content);
		const re = /```echarts\s*\n?([\s\S]*?)```/g;
		let mm: RegExpExecArray | null;
		while ((mm = re.exec(text)) !== null) {
			const block = "```echarts\n" + mm[1].trim() + "\n```";
			if (!blocks.includes(block)) blocks.push(block);
		}
	}
	return blocks;
}

function appendRawCharts(answer: string, messages: unknown[]): string {
	const blocks = collectRawCharts(messages);
	if (blocks.length === 0) return answer;
	return answer ? `${answer}\n\n${blocks.join("\n\n")}` : blocks.join("\n\n");
}

function appendRawTables(answer: string, messages: unknown[]): string {
	const tables = collectRawTables(messages);
	// 仅当本轮有工具返回表格时,剔除模型重复输出的表格并追加工具原文;无工具表格时,保留模型自己输出的表格
	if (tables.length === 0) return answer;
	let out = stripMarkdownTables(answer);
	// 防重复:即使已包含工具原文,也统一只保留一份
	for (const table of tables) out = out.replace(table, "");
	out = out.replace(/\n{3,}/g, "\n\n").trim();
	return out ? `${out}\n\n${tables.join("\n\n")}` : tables.join("\n\n");
}
/** 从 assistant 消息 content(TextContent[] 或字符串)提取纯文本。 */
function assistantText(content: unknown): string {
	if (!content) return "";
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((c) => {
				const item = c as { type?: string; text?: string };
				return typeof item?.text === "string" ? item.text : "";
			})
			.join("");
	}
	return "";
}
export interface SalesAgentResult {
	runId: string;
	final?: AgentFinal;
	messages: unknown[];
	plan?: PlanDetails;
	verification?: PlanVerification;
	executedTools?: string[];
}

export async function runSalesAgent(deps: SalesAgentDeps, input: SalesAgentInput): Promise<SalesAgentResult> {
	const { db, tenantId, store } = deps;
	if (!input.goal || !input.goal.trim()) throw new Error("goal is empty");

	const runtime = deps.runtime ?? createModelRegistry();
	const streamFn = deps.streamFn ?? runtime.streamFn;

	const model = runtime.models.getModel(config.modelProvider, config.modelId);
	if (!model) throw new Error(`model not found: ${config.modelProvider}/${config.modelId}`);

	const basePrompt = getSalesAgentSystemPrompt({
		companyName: config.companyName,
		teamName: config.teamName,
	});
	const systemPrompt = input.plan && input.plan.steps?.length
		? `${basePrompt}\n\n【执行计划】按以下计划执行,可依据实际结果灵活调整顺序,但不要遗漏关键步骤:\n${input.plan.steps.map((s, i) => `${i + 1}. ${s.step}${s.tool ? ` (工具:${s.tool})` : ""} - ${s.purpose}`).join("\n")}`
		: basePrompt;
	const capabilityStates = listCapabilityStates(db, tenantId);
	const disabled = new Set(capabilityStates.filter((c) => !c.enabled).map((c) => c.name));
	const tools = (await createSalesAgentTools({ db, tenantId, store })).filter(
		(t) => t.name === "emit_final" || !disabled.has(t.name),
	);

	const runId = randomUUID();
	const annotations: string[] = [];
	if (input.customerKey) annotations.push(`目标客户标识: ${input.customerKey}`);
	if (input.conversationId) annotations.push(`目标会话 ID: ${input.conversationId}`);
	const goalText = annotations.length ? `${input.goal}\n\n${annotations.join("\n")}` : input.goal;

	const stateMessages = Array.isArray(input.history) ? input.history : [];
	const agent = new Agent({
		sessionId: runId,
		streamFn,
		initialState: { systemPrompt, tools: tools as never, model, messages: stateMessages },
	});

	const executedTools: string[] = [];
	const recorder = createTimelineRecorder(db, { tenantId, conversationId: runId });
	agent.subscribe((event) => {
		recorder.listen(event);
		if (input.collectExecutedTools) {
			for (const ce of toClientEvents(event)) {
				if (ce.type === "tool_start" && ce.toolName && !executedTools.includes(ce.toolName)) executedTools.push(ce.toolName);
			}
		}
		if (input.onProgress) {
			for (const ce of toClientEvents(event)) {
				if (ce.type === "tool_start" || ce.type === "tool_end" || ce.type === "tool_update") {
					input.onProgress({ type: ce.type, toolCallId: ce.toolCallId, toolName: ce.toolName, label: toolLabel(ce.toolName), payload: ce.payload });
				}
			}
		}
	});

	try {
		await agent.prompt(goalText);
		await recorder.flush();
	} catch (error) {
		await recorder.flush().catch(() => undefined);
		throw error;
	}

	const messages = agent.state.messages;
	let final: AgentFinal | undefined;
	for (const message of messages) {
		if (message.role === "toolResult" && (message as { toolName?: string }).toolName === "emit_final") {
			const details = (message as { details?: Partial<AgentFinal> }).details;
			if (details?.answer) {
				final = {
					answer: details.answer,
					summary: details.summary,
					nextSteps: Array.isArray(details.nextSteps) ? details.nextSteps : [],
				};
			}
		}
	}
	// 兜底:模型可能不调用 emit_final 而直接输出普通文本;此时把最后一条 assistant 文本作为最终答复
	if (!final) {
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i] as { role?: string; content?: unknown };
			if (message.role !== "assistant") continue;
			const text = assistantText(message.content);
			if (text.trim()) {
				final = { answer: text.trim(), summary: undefined, nextSteps: [] };
				break;
			}
		}
	}

	// 表格保真:模型若未原样呈现工具表格(转述/重排),在最终答复末尾追加原始表格
	if (final?.answer) final.answer = appendRawTables(final.answer, messages);
	// 图表保真:工具返回的 ECharts 图表块原样追加到最终答复,由前端渲染
	if (final?.answer) final.answer = appendRawCharts(final.answer, messages);
	return { runId, final, messages, executedTools };
}

/** 规划阶段:只用 emit_plan,输出执行计划(不执行任何工具)。 */
export async function runPlanPhase(deps: SalesAgentDeps, input: { goal: string }): Promise<PlanDetails> {
	const runtime = deps.runtime ?? createModelRegistry();
	const streamFn = deps.streamFn ?? runtime.streamFn;
	const model = runtime.models.getModel(config.modelProvider, config.modelId);
	if (!model) throw new Error(`model not found: ${config.modelProvider}/${config.modelId}`);

	const toolNames = (await createSalesAgentTools({ db: deps.db, tenantId: deps.tenantId, store: deps.store })).map((t) => t.name);
	const systemPrompt = `你是「销售军师」的执行规划器。请为下面的任务输出一份执行计划。
可用工具(规划时只能从这些真实工具名中选取):${toolNames.join("、")}
规则:
- 只调用 emit_plan 输出计划,规划阶段不执行其他工具;
- 步骤控制在 2-8 步,每步说明:做什么(step)、拟调用工具(tool)、预期产出(purpose);
- 每个步骤的 tool 请从「可用工具」中选取真实存在的工具名;若没有合适工具,该步骤的 tool 留空;
- 复杂查询/多数据源任务要拆步骤,单步简单查询可只列 1-2 步。
任务:${input.goal}`.trim();

	const agent = new Agent({
		sessionId: `plan-${randomUUID()}`,
		streamFn,
		initialState: { systemPrompt, tools: createPlanTools() as never, model, messages: [] },
	});
	await agent.prompt(input.goal);

	for (const message of agent.state.messages as Array<{ role?: string; toolName?: string; details?: unknown }>) {
		if (message.role === "toolResult" && message.toolName === "emit_plan" && message.details) {
			const d = message.details as PlanDetails;
			if (Array.isArray(d.steps) && d.steps.length) return { summary: d.summary, steps: d.steps };
		}
	}
	throw new Error("规划阶段未产出计划");
}

/** 验证:对照规划步骤拟用工具与实际调用工具,输出覆盖/缺失摘要。 */
export function verifyPlan(plan: PlanDetails, executedTools: string[]): PlanVerification {
	const planned = (plan.steps ?? []).map((s) => s.tool).filter(Boolean);
	const covered = planned.filter((t) => executedTools.includes(t));
	const missing = planned.filter((t) => !executedTools.includes(t));
	const summary =
		missing.length === 0
			? `计划 ${planned.length} 个工具步骤全部执行,验证通过。`
			: `计划 ${planned.length} 个工具步骤,已执行 ${covered.length} 个,未执行 ${missing.join("、")}(可能因实际数据无需调用)。`;
	return { planned: planned.length, executed: [...new Set(executedTools)], coveredTools: covered, missingTools: missing, summary };
}

/** 规划-执行-验证(P-E-V):先规划(落库+plan 事件),再按计划执行,最后验证并回填。 */
export async function runSalesAgentWithPlan(deps: SalesAgentDeps, input: SalesAgentInput): Promise<SalesAgentResult> {
	const runId = randomUUID();
	const plan = await runPlanPhase(deps, { goal: input.goal });
	recordAgentPlan(deps.db, { runId, tenantId: deps.tenantId, goal: input.goal, plan });
	if (input.onProgress) input.onProgress({ type: "plan", toolName: "emit_plan", label: "执行计划", payload: plan });

	const result = await runSalesAgent(deps, { ...input, plan, collectExecutedTools: true });
	updateAgentPlan(deps.db, deps.tenantId, runId, { status: "executed", executedTools: result.executedTools });

	const verification = verifyPlan(plan, result.executedTools ?? []);
	updateAgentPlan(deps.db, deps.tenantId, runId, { status: "verified", verification });
	if (input.onProgress) input.onProgress({ type: "verified", toolName: "verify", label: "执行验证", payload: verification });

	return { ...result, runId, plan, verification };
}