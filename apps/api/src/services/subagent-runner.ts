import type { DatabaseSync } from "node:sqlite";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import { createModelRegistry, type ModelRuntime } from "../pi/models.js";
import { loadExternalAgentTools, externalToolPaths } from "./external-tools.js";
import { config } from "../env.js";
import { claimKanbanCard, finishKanbanCard, listKanbanCards, type KanbanCard } from "./kanban-store.js";

/** 子代理默认工具白名单:只读/安全工具;禁止编排类工具(不能派生子代理/不能抢看板)。 */
const DEFAULT_SUBAGENT_TOOLS = [
	"knowledge_search", "customer_query", "conversation_query", "vehicle_query", "insight_query", "funnel_query",
	"sql", "computer", "table_generate", "chart_generate", "date_tool", "dialog_extract", "keyword_extract_free",
	"similarity", "embedding", "file_read", "txt", "excel", "ppt",
];
/** 多代理模式下子代理绝对不允许使用的工具(派生/编排)。 */
const FORBIDDEN_SUBAGENT_TOOLS = new Set(["subagents", "kanban", "todo_list", "emit_final"]);

export interface SubagentRunnerDeps {
	db: DatabaseSync;
	runtime?: ModelRuntime;
	streamFn?: StreamFn;
}

/** 并行执行上限(资源隔离:同一批最多并发 2 个子代理,避免抢占)。 */
const MAX_CONCURRENCY = 2;

function subagentSystemPrompt(card: KanbanCard, tools: string[]): string {
	return `你是「销售军师」的子代理,专注执行单个明确目标,不展开无关动作。
任务目标:${card.goal ?? card.title}
可用工具:${tools.join(", ") || "(无)"}
规则:只基于工具返回的数据作答,禁止编造;不允许派生子代理,不允许修改看板;执行完用一两句话直接输出结论文本。`.trim();
}

/** 从 agent 消息中提取最终答复:优先最后一条 assistant 文本(子代理不使用 emit_final)。 */
function extractAnswer(messages: unknown[]): string {
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

async function runSubTask(deps: SubagentRunnerDeps, card: KanbanCard): Promise<string> {
	const runtime = deps.runtime ?? createModelRegistry();
	const streamFn = deps.streamFn ?? runtime.streamFn;
	const model = runtime.models.getModel(config.modelProvider, config.modelId);
	if (!model) throw new Error(`model not found: ${config.modelProvider}/${config.modelId}`);

	const all = await loadExternalAgentTools(externalToolPaths(), { db: deps.db, tenantId: card.tenantId });
	const allowed = (card.tools && card.tools.length > 0 ? card.tools : DEFAULT_SUBAGENT_TOOLS).filter((t) => !FORBIDDEN_SUBAGENT_TOOLS.has(t));
	const tools = all.filter((t) => allowed.includes(t.name));

	const agent = new Agent({
		sessionId: `sub-${card.id}`,
		streamFn,
		initialState: { systemPrompt: subagentSystemPrompt(card, tools.map((t) => t.name)), tools: tools as never, model, messages: [] },
	});
	await agent.prompt(card.goal ?? card.title);
	return extractAnswer(agent.state.messages);
}

/** 消费看板:取 pending 卡片并行执行(至多 MAX_CONCURRENCY),结果回填看板。 */
export async function consumeKanbanSubagents(deps: SubagentRunnerDeps, tenantId: string, opts: { limit?: number } = {}): Promise<KanbanCard[]> {
	const pending = listKanbanCards(tenantId, "pending").slice(0, opts.limit ?? MAX_CONCURRENCY);
	if (pending.length === 0) return [];
	const results: KanbanCard[] = [];
	await Promise.all(
		pending.map(async (card) => {
			claimKanbanCard(tenantId, card.id);
			try {
				const result = await runSubTask(deps, card);
				finishKanbanCard(tenantId, card.id, { ok: true, result });
			} catch (error) {
				finishKanbanCard(tenantId, card.id, { ok: false, error: error instanceof Error ? error.message : String(error) });
			}
		}),
	);
	for (const card of pending) {
		const updated = listKanbanCards(tenantId).find((c) => c.id === card.id);
		if (updated) results.push(updated);
	}
	return results;
}

/** 启动子代理消费者:每 15 秒扫描一次看板,按租户消费 pending 卡片。 */
export function startSubagentConsumer(deps: SubagentRunnerDeps, tenantIds: string[] = []): () => void {
	const timer = setInterval(() => {
		const tenants = tenantIds.length > 0 ? tenantIds : ["t_demo"];
		for (const tenantId of tenants) {
			consumeKanbanSubagents(deps, tenantId, { limit: MAX_CONCURRENCY }).catch((error) => {
				console.warn(`[subagents] 消费失败(${tenantId}): ${error instanceof Error ? error.message : String(error)}`);
			});
		}
	}, 15_000);
	timer.unref?.();
	return () => clearInterval(timer);
}