import type { DatabaseSync } from "node:sqlite";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import { createModelRegistry, type ModelRuntime } from "../pi/models.js";
import { loadExternalAgentTools, externalToolPaths } from "./external-tools.js";
import { config } from "../env.js";
import { claimKanbanCard, finishKanbanCard, listKanbanCards, type KanbanCard } from "./kanban-store.js";
import { getSubagentPrompt } from "../prompts/multi-agent.js";
import { isStopped } from "./stop-signal.js";

/** 子代理默认工具白名单(来自配置 subagents.defaultTools)。 */
const DEFAULT_SUBAGENT_TOOLS = config.subagentDefaultTools;
/** 多代理模式下子代理绝对不允许使用的工具(派生/编排)。 */
const FORBIDDEN_SUBAGENT_TOOLS = new Set(["subagents", "kanban", "emit_final"]);
export interface SubagentRunnerDeps {
	db: DatabaseSync;
	runtime?: ModelRuntime;
	streamFn?: StreamFn;
}

/** 并行执行上限(资源隔离:同一批最多并发 2 个子代理,避免抢占)。 */
const MAX_CONCURRENCY = config.subagentMaxConcurrency;

function subagentSystemPrompt(card: KanbanCard, tools: string[]): string {
	return getSubagentPrompt({ goal: card.goal ?? card.title, tools });
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
	if (await isStopped(card.threadId)) throw new Error("agent stopped by user");
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
	// 执行中定时检查停止键:用户点击停止后,正在执行的子代理立即中止(不再等待模型完成)
	const stopTimer = setInterval(() => {
		isStopped(card.threadId)
			.then((stopped) => { if (stopped) agent.abort(); })
			.catch(() => undefined);
	}, 2000);
	try {
		await agent.prompt(card.goal ?? card.title);
	} finally {
		clearInterval(stopTimer);
	}
	return extractAnswer(agent.state.messages);
}

/** 消费看板:取 pending 卡片并行执行(至多 MAX_CONCURRENCY),结果回填看板。 */
export async function consumeKanbanSubagents(deps: SubagentRunnerDeps, tenantId: string, opts: { limit?: number; threadId?: string } = {}): Promise<KanbanCard[]> {
	if (opts.threadId && await isStopped(opts.threadId)) return [];
	const pending = listKanbanCards(deps.db, tenantId, { status: "pending", threadId: opts.threadId }).slice(0, opts.limit ?? MAX_CONCURRENCY);
	if (pending.length === 0) return [];
	const results: KanbanCard[] = [];
	await Promise.all(
		pending.map(async (card) => {
			claimKanbanCard(deps.db, tenantId, card.id);
			try {
				const result = await runSubTask(deps, card);
				finishKanbanCard(deps.db, tenantId, card.id, { ok: true, result });
			} catch (error) {
				finishKanbanCard(deps.db, tenantId, card.id, { ok: false, error: error instanceof Error ? error.message : String(error) });
			}
		}),
	);
	for (const card of pending) {
		const updated = listKanbanCards(deps.db, tenantId, { threadId: opts.threadId }).find((c) => c.id === card.id);
		if (updated) results.push(updated);
	}
	return results;
}

/** 启动子代理消费者:按轮询间隔扫描看板,消费全部线程的 pending 卡片(含多代理任务)。 */
export function startSubagentConsumer(deps: SubagentRunnerDeps, tenantIds: string[] = []): () => void {
	const timer = setInterval(() => {
		const tenants = tenantIds.length > 0 ? tenantIds : ["t_demo"];
		for (const tenantId of tenants) {
			// 按线程分组取 pending 卡片,逐线程消费(每个线程并发上限 MAX_CONCURRENCY)
			const pending = listKanbanCards(deps.db, tenantId, { status: "pending" });
			const threadIds = [...new Set(pending.map((c) => c.threadId))];
			for (const threadId of threadIds) {
				consumeKanbanSubagents(deps, tenantId, { limit: MAX_CONCURRENCY, threadId }).catch((error) => {
					console.warn(`[subagents] 消费失败(${tenantId}/${threadId}): ${error instanceof Error ? error.message : String(error)}`);
				});
			}
		}
	}, config.subagentPollIntervalMs);
	timer.unref?.();
	return () => clearInterval(timer);
}
