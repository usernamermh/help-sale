import type { DatabaseSync } from "node:sqlite";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import { createModelRegistry, type ModelRuntime } from "../pi/models.js";
import { loadExternalAgentTools, externalToolPaths } from "./external-tools.js";
import { config } from "../env.js";
import { getSubTask, listSubTasks, updateSubTask, type SubTask } from "./subagent-queue.js";

/** 子代理默认工具白名单:只读/安全工具,避免子代理做写操作。 */
const DEFAULT_SUBAGENT_TOOLS = [
	"knowledge_search", "customer_query", "conversation_query", "vehicle_query", "insight_query", "funnel_query",
	"sql", "computer", "table_generate", "chart_generate", "date_tool", "dialog_extract", "keyword_extract_free",
];

export interface SubagentRunnerDeps {
	db: DatabaseSync;
	runtime?: ModelRuntime;
	streamFn?: StreamFn;
}

function subagentSystemPrompt(task: SubTask, tools: string[]): string {
	return `你是「销售军师」的子代理,专注执行单个明确目标,不展开无关动作。
任务目标:${task.goal}
可用工具:${tools.join(", ") || "(无)"}
${task.input ? `额外输入:${JSON.stringify(task.input)}` : ""}
规则:只基于工具返回的数据作答,禁止编造;执行完用一两句话直接输出结论文本,不要调用任何收口工具。`.trim();
}

/** 从 agent 消息中提取最终答复:优先 emit_final,否则最后一条 assistant 文本。 */
function extractAnswer(messages: unknown[]): string {
	for (const message of messages) {
		const m = message as { role?: string; toolName?: string; details?: { answer?: string } };
		if (m.role === "toolResult" && m.toolName === "emit_final" && m.details?.answer) return m.details.answer;
	}
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string; content?: unknown };
		if (m.role !== "assistant") continue;
		const text = Array.isArray(m.content)
			? m.content.map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text?: string }).text ?? "") : "")).join("")
			: typeof m.content === "string"
				? m.content
				: "";
		if (text.trim()) return text.trim();
	}
	throw new Error("子代理未产出结论");
}

async function runSubTask(deps: SubagentRunnerDeps, task: SubTask): Promise<string> {
	const runtime = deps.runtime ?? createModelRegistry();
	const streamFn = deps.streamFn ?? runtime.streamFn;
	const model = runtime.models.getModel(config.modelProvider, config.modelId);
	if (!model) throw new Error(`model not found: ${config.modelProvider}/${config.modelId}`);

	const all = await loadExternalAgentTools(externalToolPaths(), { db: deps.db, tenantId: task.tenantId });
	const allowed = task.tools && task.tools.length > 0 ? task.tools : DEFAULT_SUBAGENT_TOOLS;
	const tools = all.filter((t) => allowed.includes(t.name));

	const agent = new Agent({
		sessionId: task.id,
		streamFn,
		initialState: { systemPrompt: subagentSystemPrompt(task, tools.map((t) => t.name)), tools: tools as never, model, messages: [] },
	});
	await agent.prompt(task.goal);
	return extractAnswer(agent.state.messages);
}

/** 消费子代理队列:执行 queued 任务并回填状态/结果。 */
export async function consumeSubagentQueue(deps: SubagentRunnerDeps, opts: { limit?: number } = {}): Promise<SubTask[]> {
	const tasks = listSubTasks("queued").slice(0, opts.limit ?? 2);
	const executed: SubTask[] = [];
	for (const task of tasks) {
		updateSubTask(task.id, { status: "running" });
		try {
			const result = await runSubTask(deps, task);
			updateSubTask(task.id, { status: "done", result });
		} catch (error) {
			updateSubTask(task.id, { status: "error", error: error instanceof Error ? error.message : String(error) });
		}
		const updated = getSubTask(task.id);
		if (updated) executed.push(updated);
	}
	return executed;
}

/** 启动子代理消费者:每 15 秒扫一次队列(至多并发 1 批);返回 stop 函数。 */
export function startSubagentConsumer(deps: SubagentRunnerDeps): () => void {
	const timer = setInterval(() => {
		consumeSubagentQueue(deps, { limit: 1 }).catch((error) => {
			console.warn(`[subagents] 消费失败: ${error instanceof Error ? error.message : String(error)}`);
		});
	}, 15_000);
	timer.unref?.();
	return () => clearInterval(timer);
}