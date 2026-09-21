import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Agent, type AgentMessage, type StreamFn } from "@earendil-works/pi-agent-core";
import { createModelRegistry, requiredModel, type ModelRuntime } from "./models.js";
import { getSalesAgentSystemPrompt } from "../prompts/sales-agent.js";
import { createPlanTools, createSalesAgentTools } from "./agent-tools.js";
import { config } from "../env.js";
import { createTimelineRecorder } from "../services/timeline.js";
import { createKanbanTask, listKanbanCards, resetKanban } from "../services/kanban-store.js";
import { consumeKanbanSubagents } from "../services/subagent-runner.js";
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
	type: "tool_start" | "tool_end" | "tool_update" | "plan" | "verified" | "text_delta";
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
	threadId?: string; // 当前会话 ID:看板按会话隔离,只展示该会话的任务
	signal?: AbortSignal; // 客户端中断信号:触发后终止 agent 循环(取消在途模型请求/工具执行)

}
export class AgentCancelledError extends Error {
	constructor(message = "agent run cancelled") {
		super(message);
		this.name = "AgentCancelledError";
	}
}

export interface PlanStep {
	step: string;
	tool: string;
	purpose: string;
}

export interface PlanDetails {
	mode?: "single" | "multi"; // 执行模式:single 单代理 / multi 多代理并行
	subtasks?: Array<{ title: string; goal: string; tools?: string[] }>; // multi 模式下的子任务清单
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
	// 多次查表时只保留最后一次工具返回的表格
	const table = tables[tables.length - 1];
	let out = stripMarkdownTables(answer);
	// 防重复:即使已包含工具原文,也统一只保留一份
	out = out.replace(table, "");
	out = out.replace(/\n{3,}/g, "\n\n").trim();
	return out ? `${out}\n\n${table}` : table;
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

	const model = requiredModel(runtime);

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
	// 把“目标客户/目标会话”附加到用户目标上
	// 如果调用方带了 customerKey（这次任务针对哪个客户）或 conversationId（针对哪段会话），就把它们拼到用户目标后面再发给模型
	if (input.customerKey) annotations.push(`目标客户标识: ${input.customerKey}`);
	if (input.conversationId) annotations.push(`目标会话 ID: ${input.conversationId}`);
	const goalText = annotations.length ? `${input.goal}\n\n${annotations.join("\n")}` : input.goal;

	const stateMessages = Array.isArray(input.history) ? input.history : [];
	const agent = new Agent({
		sessionId: runId,
		streamFn,
		initialState: { systemPrompt, tools: tools as never, model, messages: stateMessages },
	});

	const onAbort = () => agent.abort();
	if (input.signal) {
		if (input.signal.aborted) onAbort();
		else input.signal.addEventListener("abort", onAbort, { once: true });
	}
	
	// 订阅事件：落库 + 收集工具 + 转发前端
	const executedTools: string[] = [];
	const recorder = createTimelineRecorder(db, { tenantId, conversationId: runId });
	agent.subscribe((event) => {
		recorder.listen(event);  // 把事件写进 agent_events 表(可回放)
		if (input.collectExecutedTools) {
			for (const ce of toClientEvents(event)) {
				if (ce.type === "tool_start" && ce.toolName && !executedTools.includes(ce.toolName)) executedTools.push(ce.toolName);
			}
		}
		if (input.onProgress) {
			for (const ce of toClientEvents(event)) {
				if (ce.type === "tool_start" || ce.type === "tool_end" || ce.type === "tool_update" || ce.type === "text_delta") {
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
	} finally {
		if (input.signal) input.signal.removeEventListener("abort", onAbort);
	}
	// 客户端中断:prompt 正常返回(消息 stopReason=aborted),但按取消处理,不产出最终答复
	if (input.signal?.aborted) throw new AgentCancelledError("agent run cancelled by client");

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
export async function runPlanPhase(deps: SalesAgentDeps, input: { goal: string; signal?: AbortSignal }): Promise<PlanDetails> {
	const runtime = deps.runtime ?? createModelRegistry();
	const streamFn = deps.streamFn ?? runtime.streamFn;
	const model = requiredModel(runtime);

	const toolNames = (await createSalesAgentTools({ db: deps.db, tenantId: deps.tenantId, store: deps.store })).map((t) => t.name);
	const systemPrompt = `你是「销售军师」的执行规划器。请为下面的任务输出一份执行计划。
可用工具(规划时只能从这些真实工具名中选取):${toolNames.join("、")}
规则:
- 选择执行模式(mode):single=你自己直接执行;multi=拆给多个子代理并行。由你根据任务实际情况自主判断:只有任务确实包含多个相互独立、可并行完成的子目标时才选 multi,否则一律 single(单代理更简单高效,不额外拆解)。
- mode=multi 时,用 subtasks 给出 2-6 个可独立并行执行的子任务(title/goal/tools),每个子任务由独立子代理执行,不要写 steps;mode=single 时用 steps 给执行步骤。
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
	const onAbort = () => agent.abort();
	if (input.signal) {
		if (input.signal.aborted) onAbort();
		else input.signal.addEventListener("abort", onAbort, { once: true });
	}
	try {
		await agent.prompt(input.goal);
	} finally {
		if (input.signal) input.signal.removeEventListener("abort", onAbort);
	}
	if (input.signal?.aborted) throw new AgentCancelledError("plan cancelled by client");

	for (const message of agent.state.messages as Array<{ role?: string; toolName?: string; details?: unknown }>) {
		if (message.role === "toolResult" && message.toolName === "emit_plan" && message.details) {
			const d = message.details as PlanDetails;
			if (Array.isArray(d.steps) && d.steps.length) return { summary: d.summary, mode: d.mode === "multi" ? "multi" : "single", steps: d.steps, subtasks: d.subtasks ?? [] };
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
			: `计划 ${planned.length} 个工具步骤,已执行 ${covered.length} 个,未执行 ${missing.join("、")}。`;
	return { planned: planned.length, executed: [...new Set(executedTools)], coveredTools: covered, missingTools: missing, summary };
}

/** 多代理执行流:主代理把子任务写上看板 -> 子代理并行执行 -> 协调者读看板检查结果并 emit_final。 */
export async function runMultiAgentFlow(deps: SalesAgentDeps, input: SalesAgentInput, plan: PlanDetails): Promise<SalesAgentResult> {
	const runtime = deps.runtime ?? createModelRegistry();
	const streamFn = deps.streamFn ?? runtime.streamFn;
	const model = requiredModel(runtime);
	const subtasks = plan.subtasks ?? [];
	if (subtasks.length === 0) throw new Error("multi 模式缺少子任务清单(subtasks)");
	const threadId = input.threadId ?? "default";

	// 1) 主代理把子任务写上看板(看板按会话隔离,只展示当前会话的任务)
	resetKanban(deps.tenantId, threadId);
	const createdCardIds: string[] = [];
	for (const st of subtasks) {
		const card = createKanbanTask({ tenantId: deps.tenantId, threadId, title: st.title, goal: st.goal, tools: st.tools });
		createdCardIds.push(card.id);
		if (input.onProgress) input.onProgress({ type: "tool_start", toolName: "kanban", label: "看板建卡", payload: { id: card.id, title: card.title } });
		if (input.onProgress) input.onProgress({ type: "tool_end", toolName: "kanban", label: "看板建卡", payload: { id: card.id, title: card.title } });
	}

	// 2) 子代理并行执行(消费者,并发上限 2;子代理不可再派生/不可改看板)
	if (input.onProgress) input.onProgress({ type: "tool_start", toolName: "subagents", label: "子代理并行执行", payload: { count: subtasks.length } });
	const deadline = Date.now() + 300_000;
	while (true) {
		await consumeKanbanSubagents({ db: deps.db, runtime, streamFn }, deps.tenantId, { limit: 2, threadId });
		const pending = listKanbanCards(deps.tenantId, { status: "pending", threadId }).length;
		if (pending === 0 || Date.now() > deadline) break;
		await new Promise((r) => setTimeout(r, 2000));
	}
	// 全部子任务就绪后,从看板读取当前会话的最终结果(后台消费者可能已代为执行部分卡片)
	const allCards = listKanbanCards(deps.tenantId, { threadId }).filter((c) => createdCardIds.includes(c.id));
	const executed = allCards.map((c) => ({ id: c.id, title: c.title, status: c.status, result: c.result, error: c.error }));
	if (input.onProgress) input.onProgress({ type: "tool_end", toolName: "subagents", label: "子代理并行执行", payload: { count: executed.length, results: executed.map((c) => ({ id: c.id, title: c.title, status: c.status, result: c.result ? c.result.slice(0, 120) : null, error: c.error ?? null })) } });

	// 3) 协调者(主代理)读看板检查结果并汇总:只挂 kanban/subagents + emit_final,不注册业务工具
	const coordinatorTools = (await createSalesAgentTools({ db: deps.db, tenantId: deps.tenantId, store: deps.store })).filter(
		(t) => t.name === "kanban" || t.name === "emit_final" || t.name === "subagents",
	);
	const coordinatorPrompt = `你是「销售军师」的多代理协调者。子代理已并行完成任务,结果写回看板卡片。
你的职责:
- 用 kanban list/get 查看各卡片状态与结果(不允许调用业务工具,业务执行已由子代理完成);
- 核对是否有卡片未完成或报错,必要时用 subagents list 复查;
- 汇总各子任务结果,向用户输出最终答复,包含每个子任务的结论;如有失败要如实说明。
目标:${input.goal}`.trim();
	const coordinator = new Agent({
		sessionId: `coord-${randomUUID()}`,
		streamFn,
		initialState: { systemPrompt: coordinatorPrompt, tools: coordinatorTools as never, model, messages: [] },
	});
	coordinator.subscribe((event) => {
		if (!input.onProgress) return;
		for (const ce of toClientEvents(event)) {
			if (ce.type === "text_delta") {
				input.onProgress({ type: "text_delta", toolCallId: undefined, toolName: undefined, label: undefined, payload: ce.payload });
			}
		}
	});
	await coordinator.prompt("子代理已执行完毕,请检查看板结果并输出最终答复。");
	const messages = coordinator.state.messages;
	let final: AgentFinal | undefined;
	for (const message of messages) {
		if (message.role === "toolResult" && (message as { toolName?: string }).toolName === "emit_final") {
			const details = (message as { details?: Partial<AgentFinal> }).details;
			if (details?.answer) {
				final = { answer: details.answer, summary: details.summary, nextSteps: Array.isArray(details.nextSteps) ? details.nextSteps : [] };
			}
		}
	}
	if (!final) {
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i] as { role?: string; content?: unknown };
			if (m.role !== "assistant") continue;
			const text = assistantText(m.content);
			if (text.trim()) { final = { answer: text.trim(), summary: undefined, nextSteps: [] }; break; }
		}
	}
	return { runId: randomUUID(), final, messages, plan, executedTools: ["kanban", "subagents"] };
}

export async function runSalesAgentWithPlan(deps: SalesAgentDeps, input: SalesAgentInput): Promise<SalesAgentResult> {
	const runId = randomUUID();
	if (input.signal?.aborted) throw new AgentCancelledError("agent run cancelled by client");
	const plan = await runPlanPhase(deps, { goal: input.goal, signal: input.signal });
	recordAgentPlan(deps.db, { runId, tenantId: deps.tenantId, goal: input.goal, plan });
	if (input.onProgress) input.onProgress({ type: "plan", toolName: "emit_plan", label: "执行计划", payload: plan });

	// 多代理模式:主代理只做规划/结果检查,业务执行由子代理并行完成
	if (plan.mode === "multi") {
		const multi = await runMultiAgentFlow(deps, input, plan);
		const verification: PlanVerification = {
			planned: plan.subtasks?.length ?? 0,
			executed: multi.executedTools ?? [],
			coveredTools: multi.executedTools ?? [],
			missingTools: [],
			summary: "多代理模式:主代理规划并检查,子代理并行执行完成。",
		};
		updateAgentPlan(deps.db, deps.tenantId, multi.runId, { status: "verified", verification });
		if (input.onProgress) input.onProgress({ type: "verified", toolName: "verify", label: "执行验证", payload: verification });
		return multi;
	}

	const result = await runSalesAgent(deps, { ...input, plan, collectExecutedTools: true });
	updateAgentPlan(deps.db, deps.tenantId, runId, { status: "executed", executedTools: result.executedTools });

	const verification = verifyPlan(plan, result.executedTools ?? []);
	updateAgentPlan(deps.db, deps.tenantId, runId, { status: "verified", verification });
	if (input.onProgress) input.onProgress({ type: "verified", toolName: "verify", label: "执行验证", payload: verification });

	return { ...result, runId, plan, verification };
}

