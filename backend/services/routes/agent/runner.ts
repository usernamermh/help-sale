// 子代理执行与消费:并行池、超时中止、停止信号、共享输出注入(原 v1 services/subagent-runner.ts)
import type { DatabaseSync } from "node:sqlite";
import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import { config } from "../../../env.js";
import { LOCAL_PROVIDER_ID, createModelRegistry, type ModelRuntime } from "../../../integrations_pi/models.js";
import { getSubagentPrompt } from "../../../prompts/multi-agent.js";
import { loadExternalAgentTools, externalToolPaths } from "../../external-tools.js";
import { applyToolPolicy } from "../../../integrations_pi/agent-tools.js";
import { listTenantIds } from "../../../integrations_pi/tables/automation/runs.js";
import type { ClusterCoordinator } from "../../../integrations_db/cluster.js";
import { registerSubagentWorker, unregisterSubagentWorker } from "./subagent-signal.js";
import { listCapabilityStates } from "../../../integrations_pi/tables/agents/capabilities.js";
import { isStopped } from "../../stop-signal.js";
import { createTimelineRecorder } from "../../timeline.js";
import { claimKanbanCard, finishKanbanCard, listKanbanCards, reclaimExpiredKanbanCards, renewKanbanLease, touchKanbanCard, type KanbanCard } from "./kanban.js";

/** 子代理默认工具白名单(来自配置 subagents.defaultTools)。 */
const DEFAULT_SUBAGENT_TOOLS = config.subagentDefaultTools;
/** 多代理模式下子代理绝对不允许使用的工具(派生/编排)。 */
const FORBIDDEN_SUBAGENT_TOOLS = new Set(["subagents", "kanban", "emit_final"]);
export interface SubagentRunnerDeps {
	db: DatabaseSync;
	runtime?: ModelRuntime;
	streamFn?: StreamFn;
	/** 多实例协调层:Redis 可用时提供主实例锁与跨实例唤醒;不传即单实例模式 */
	cluster?: ClusterCoordinator;
}

/** 并行执行上限(资源隔离:同一批最多并发 2 个子代理,避免抢占)。 */
const MAX_CONCURRENCY = config.subagentMaxConcurrency;

function subagentSystemPrompt(card: KanbanCard, tools: string[], sharedOutputs?: string): string {
	return getSubagentPrompt({ goal: card.goal ?? card.title, tools, sharedOutputs });
}

/** 读取同一批看板中"已完成"的其他子代理结果,供允许共享的子代理参考(并发池分批执行:后批子代理可见前批结论)。 */
function collectSharedOutputs(db: DatabaseSync, card: KanbanCard): string {
	if (card.shareEnabled !== true) return "";
	const others = listKanbanCards(db, card.tenantId, { threadId: card.threadId })
		.filter((c) => c.id !== card.id && c.status === "done" && c.result)
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	if (others.length === 0) return "";
	const lines = others.map((c) => `- [${c.title}] ${(c.result ?? "").slice(0, 2000)}`);
		return lines.join("\n");
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
	const model = runtime.models.getModel(LOCAL_PROVIDER_ID, config.modelId);
	if (!model) throw new Error(`model not found: ${LOCAL_PROVIDER_ID}/${config.modelId}`);

	const all = await loadExternalAgentTools(externalToolPaths(), { db: deps.db, tenantId: card.tenantId });
	const allowed = (card.tools && card.tools.length > 0 ? card.tools : DEFAULT_SUBAGENT_TOOLS).filter((t) => !FORBIDDEN_SUBAGENT_TOOLS.has(t));
	const tools = applyToolPolicy(all.filter((t) => allowed.includes(t.name)), listCapabilityStates(deps.db, card.tenantId), "subagent");

	// 共享输出:主代理允许时,把其他已完成子代理的最新结论注入本子代理 prompt(并发池分批执行场景)
	const sharedOutputs = collectSharedOutputs(deps.db, card);
	const agent = new Agent({
		sessionId: `sub-${card.id}`,
		streamFn,
		initialState: { systemPrompt: subagentSystemPrompt(card, tools.map((t) => t.name), sharedOutputs), tools: tools as never, model, messages: [] },
	});
	// 子代理轨迹落库:此前子代理完全不写 agent_events,而 multi 模式恰恰最容易形成稳定套路,
	// 挖掘因此看不到任何子代理链路。这里以 sub-<cardId> 为运行标识写入,线程归属沿用宿主 threadId。
	const recorder = createTimelineRecorder(deps.db, { tenantId: card.tenantId, conversationId: `sub-${card.id}`, threadId: card.threadId });
	agent.subscribe((event) => recorder.listen(event));
	// 心跳:定期刷新卡片 updated_at,供主代理监督判断是否仍在执行(避免被误判为无进展)
	const heartbeat = setInterval(() => {
		try { touchKanbanCard(deps.db, card.tenantId, card.id); } catch { /* 忽略 */ }
	}, 30000);
	// 单任务超时:超过上限仍未完成视为执行卡死,主动中止(兜底,避免永久占用资源)
	const taskTimer = setTimeout(() => { agent.abort(); }, config.subagentTimeoutMs);
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
		clearInterval(heartbeat);
		clearTimeout(taskTimer);
		// 无论成功/失败/超时中止,已产生的工具事件都要落库(失败轨迹同样供挖掘与复盘参考)
		await recorder.flush().catch(() => undefined);
	}
	return extractAnswer(agent.state.messages);
}

/** 跨实例唤醒频道(Redis 可用时生效)。 */
export const SUBAGENT_WAKE_CHANNEL = "rmh:subagents:wake";

/** 消费看板:取 pending 卡片并行执行(至多 MAX_CONCURRENCY),结果回填看板。 */
export async function consumeKanbanSubagents(deps: SubagentRunnerDeps, tenantId: string, opts: { limit?: number; threadId?: string } = {}): Promise<KanbanCard[]> {
	if (opts.threadId && await isStopped(opts.threadId)) return [];
	const pending = listKanbanCards(deps.db, tenantId, { status: "pending", threadId: opts.threadId }).slice(0, opts.limit ?? MAX_CONCURRENCY);
	if (pending.length === 0) return [];
	const results: KanbanCard[] = [];
	const owner = deps.cluster?.instanceId ?? "single-instance";
	const leaseMs = config.subagentTimeoutMs;
	await Promise.all(
		pending.map(async (card) => {
			// 原子领取:多实例同时扫到同一张卡时,只有把 pending 改成 inprogress 成功的那一个才算抢到
			if (!claimKanbanCard(deps.db, tenantId, card.id, { owner, leaseMs })) return;
			// 执行期间续租,避免长任务被别的实例当成过期接管
			const heartbeat = setInterval(() => {
				try {
					renewKanbanLease(deps.db, tenantId, card.id, owner, leaseMs);
				} catch {
					// 心跳失败不影响执行
				}
			}, Math.max(1000, Math.floor(leaseMs / 3)));
			heartbeat.unref?.();
			try {
				const result = await runSubTask(deps, card);
				finishKanbanCard(deps.db, tenantId, card.id, { ok: true, result });
			} catch (error) {
				finishKanbanCard(deps.db, tenantId, card.id, { ok: false, error: error instanceof Error ? error.message : String(error) });
			} finally {
				clearInterval(heartbeat);
			}
		}),
	);
	for (const card of pending) {
		const updated = listKanbanCards(deps.db, tenantId, { threadId: opts.threadId }).find((c) => c.id === card.id);
		if (updated) results.push(updated);
	}
	return results;
}

/** 一次扫描:清理孤儿卡 + 消费各租户的 pending 卡;返回"是否还有活"。 */
async function sweepKanban(deps: SubagentRunnerDeps, tenantIds: string[]): Promise<boolean> {

	// 不传就枚举库里的全部租户:后台任务不能只服务"配置里的那个租户"
	const tenants = tenantIds.length > 0 ? tenantIds : listTenantIds(deps.db);
	let hadWork = false;
	for (const tenantId of tenants) {
		// 整段都要兜住:轮询里的数据库异常若不接住会从定时器冒出去,直接把服务带崩
		try {
			// 按线程分组取 pending 卡片,逐线程消费(每个线程并发上限 MAX_CONCURRENCY)
			// 领取者崩了/卡死了:租约到期就把卡放回 pending(超过重试上限判 error)
			reclaimExpiredKanbanCards(deps.db, tenantId, { maxAttempts: config.subagentMaxAttempts });
			const pending = listKanbanCards(deps.db, tenantId, { status: "pending" });
			if (pending.length === 0) continue;
			hadWork = true;
			const threadIds = [...new Set(pending.map((c) => c.threadId))];
			for (const threadId of threadIds) {
				consumeKanbanSubagents(deps, tenantId, { limit: MAX_CONCURRENCY, threadId }).catch((error) => {
					console.warn(`[subagents] 消费失败(${tenantId}/${threadId}): ${error instanceof Error ? error.message : String(error)}`);
				});
			}
		} catch (error) {
			console.warn(`[subagents] 轮询失败(${tenantId}): ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return hadWork;
}

/**
 * 子代理消费者:事件驱动,**空闲不轮询**。
 *   · 启动扫一次:恢复上个进程遗留的 pending,并清理孤儿 inprogress 卡;
 *   · 之后由 notifySubagentWork() 唤醒(建卡、或把卡改回 pending 时触发);
 *   · 被唤醒后只要还有活,就按 subagents.pollIntervalMs 的节奏连续扫;没活立刻退出;
 *   · subagents.idleSweepIntervalMs > 0 时保留一条低频兜底扫描(跨进程/崩溃恢复用),设 0 即完全事件驱动。
 */
export function startSubagentConsumer(deps: SubagentRunnerDeps, tenantIds: string[] = []): () => void {
	let stopped = false;
	let draining = false;
	let scheduled: NodeJS.Timeout | undefined;
	let idleTimer: NodeJS.Timeout | undefined;

	const drain = async (): Promise<void> => {
		if (stopped || draining) return;
		draining = true;
		try {
			let rounds = 0;
			for (;;) {
				const hadWork = await sweepKanban(deps, tenantIds);
				rounds += 1;
				if (stopped || !hadWork) break;
				await new Promise((resolve) => setTimeout(resolve, Math.max(100, config.subagentPollIntervalMs)));
			}
			if (rounds > 1) console.log(`[subagents] 本轮消费结束(扫描 ${rounds} 次)`);
		} finally {
			draining = false;
		}
	};

	// 事件唤醒:合并同一批多次通知,避免一次提交触发 N 次扫描
	const kick = (): void => {
		if (stopped || scheduled) return;
		scheduled = setTimeout(() => {
			scheduled = undefined;
			void drain();
		}, 0);
		scheduled.unref?.();
	};

	registerSubagentWorker(kick);
	// 多实例:订阅跨实例唤醒频道 —— 别的实例建卡时,本进程也会立刻扫一次
	const unsubscribeWake = deps.cluster?.subscribe(SUBAGENT_WAKE_CHANNEL, () => kick()) ?? (() => undefined);
	void drain(); // 启动即扫一次(恢复遗留任务)
	if (config.subagentIdleSweepIntervalMs > 0) {
		idleTimer = setInterval(() => void drain(), config.subagentIdleSweepIntervalMs);
		idleTimer.unref?.();
	}

	return () => {
		stopped = true;
		unsubscribeWake();
		unregisterSubagentWorker();
		if (scheduled) clearTimeout(scheduled);
		if (idleTimer) clearInterval(idleTimer);
	};
}