// threads.ts(由 v1 routes/threads.ts 迁移)
import type { FastifyInstance } from "fastify";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { appendThreadMessage, createThread, deleteAllThreads, deleteThread, getThread, listThreadMessages, listThreads, setThreadTitle } from "../../integrations_pi/tables/agents/threads.js";
import { runSalesAgent, runSalesAgentWithPlan, collectMultiAgentFlow, stripChartsForHistory } from "../../integrations_pi/agent-runtime.js";
import { getAgentPlanByRun } from "../../integrations_pi/tables/agents/plans.js";
import { listAgentEvents } from "../../integrations_pi/tables/agents/events.js";
import { setStopSignal, clearStopSignal } from "../stop-signal.js";
import { listKanbanCards, removeKanbanByThread } from "./agent/kanban.js";
import { buildContextForThread, ensureThreadSummary } from "../context-compress.js";
import { getThreadSummary } from "../../integrations_pi/tables/agents/summaries.js";
import { createReflectionCase } from "../../integrations_pi/tables/analysis/reflections.js";
import { executeToolPage } from "../tool-pagination.js";
import { subscribeThreadEvents } from "../thread-events.js";
import { config } from "../../env.js";
import type { RouteDeps } from "./helpers.js";

export function registerThreadRoutes(app: FastifyInstance, deps: RouteDeps): void {
	app.post<{ Body: { goal?: string; customerKey?: string; conversationId?: string; history?: AgentMessage[] } }>("/api/v1/agent/run", async (request, reply) => {
		const { goal, customerKey, conversationId, history } = request.body ?? {};
		if (!goal || !goal.trim()) return reply.code(400).send({ error: "goal is required" });
		let result;
		try {
			result = await runSalesAgent(
				{ db: deps.db, tenantId: request.tenantId, store: deps.store, runtime: deps.runtime, streamFn: deps.streamFn },
				{ goal, customerKey, conversationId, history },
			);
		} catch (error) {
			createReflectionCase(deps.db, {
				tenantId: request.tenantId,
				caseType: "run_failed",
				detail: { error: error instanceof Error ? error.message : String(error), goal: goal.slice(0, 200) },
			});
			return reply.code(500).send({ error: "agent_run_failed", message: error instanceof Error ? error.message : String(error) });
		}
		return { runId: result.runId, final: result.final, hasResponse: Boolean(result.final) };
	});

	// 会话事件流(SSE):微信等外部渠道写入消息或改标题时,网页端同步更新,不用手动刷新
	app.get("/api/v1/agent/threads/stream", async (request, reply) => {
		reply.hijack();
		const raw = reply.raw;
		raw.writeHead(200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		});
		raw.write(": connected\n\n");
		const unsubscribe = subscribeThreadEvents((event) => {
			if (event.tenantId !== request.tenantId) return;
			try {
				raw.write(`data: ${JSON.stringify(event)}\n\n`);
			} catch {
				// 客户端已断开:由 close 事件负责清理
			}
		});
		const heartbeat = setInterval(() => {
			try {
				raw.write(": ping\n\n");
			} catch {
				// 同上
			}
		}, 15000);
		request.raw.on("close", () => {
			clearInterval(heartbeat);
			unsubscribe();
		});
		return reply;
	});
	app.post("/api/v1/agent/threads", async (request) => {
		return createThread(deps.db, request.tenantId);
	});

	app.delete("/api/v1/agent/threads", async (request) => {
		const removed = deleteAllThreads(deps.db, request.tenantId);
		// 清空全部会话时,一并清理所有会话关联的运行记录(执行计划/事件时间线)
		deps.db.prepare("DELETE FROM agent_events WHERE tenant_id = ? AND thread_id IS NOT NULL").run(request.tenantId);
		deps.db.prepare("DELETE FROM agent_plans WHERE tenant_id = ? AND thread_id IS NOT NULL").run(request.tenantId);
		return { removed };
	});

	app.get("/api/v1/agent/threads", async (request) => {
		const threads = listThreads(deps.db, request.tenantId, config.agentThreadsLimit);
		return { threads };
	});

	app.get<{ Params: { id: string } }>("/api/v1/agent/threads/:id", async (request, reply) => {
		const thread = getThread(deps.db, request.tenantId, request.params.id);
		if (!thread) return reply.code(404).send({ error: "thread_not_found", message: "会话不存在" });
		const messages = listThreadMessages(deps.db, request.tenantId, thread.id).map((m) => ({
			id: m.id,
			seq: m.seq,
			role: m.role,
			content: m.content,
			createdAt: m.createdAt,
		}));
		return { thread, messages };
	});

	app.get<{ Params: { id: string } }>("/api/v1/agent/threads/:id/export", async (request, reply) => {
		const thread = getThread(deps.db, request.tenantId, request.params.id);
		if (!thread) return reply.code(404).send({ error: "thread_not_found", message: "会话不存在" });
		const messages = listThreadMessages(deps.db, request.tenantId, thread.id).map((m) => ({
			id: m.id,
			seq: m.seq,
			role: m.role,
			content: m.content,
			createdAt: m.createdAt,
		}));
		return { thread, messages };
	});

	app.delete<{ Params: { id: string } }>("/api/v1/agent/threads/:id", async (request, reply) => {
		const removed = deleteThread(deps.db, request.tenantId, request.params.id);
		if (!removed) return reply.code(404).send({ error: "thread_not_found", message: "会话不存在" });
		if (removed) {
			removeKanbanByThread(deps.db, request.tenantId, request.params.id);
			// 任务删除后不再保留该会话的任何运行记录(看板/执行计划/事件时间线/停止键)
			deps.db.prepare("DELETE FROM agent_events WHERE tenant_id = ? AND thread_id = ?").run(request.tenantId, request.params.id);
			deps.db.prepare("DELETE FROM agent_plans WHERE tenant_id = ? AND thread_id = ?").run(request.tenantId, request.params.id);
			clearStopSignal(request.params.id).catch(() => undefined);
		}
		return { removed: true };
	});

	app.post<{ Params: { id: string } }>("/api/v1/agent/threads/:id/stop", async (request, reply) => {
		const thread = getThread(deps.db, request.tenantId, request.params.id);
		if (!thread) return reply.code(404).send({ error: "thread_not_found", message: "会话不存在" });
		await setStopSignal(thread.id);
		return { stopped: true };
	});

	app.get<{ Params: { id: string } }>("/api/v1/agent/threads/:id/summary", async (request, reply) => {
		const thread = getThread(deps.db, request.tenantId, request.params.id);
		if (!thread) return reply.code(404).send({ error: "thread_not_found", message: "会话不存在" });
		let summary = getThreadSummary(deps.db, request.tenantId, thread.id);
		if (!summary) {
			try {
				const text = ensureThreadSummary(deps.db, request.tenantId, thread.id);
				summary = { id: "", tenantId: request.tenantId, threadId: thread.id, summary: text, messageSeqUntil: 0, createdAt: "", updatedAt: "" };
			} catch {
				return { threadId: thread.id, summary: null };
			}
		}
		return { threadId: thread.id, summary: summary?.summary ?? null, messageSeqUntil: summary?.messageSeqUntil ?? 0 };
	});

	app.post<{ Params: { id: string }; Body: { goal?: string } }>("/api/v1/agent/threads/:id/run-stream", async (request, reply) => {
		const thread = getThread(deps.db, request.tenantId, request.params.id);
		if (!thread) return reply.code(404).send({ error: "thread_not_found", message: "会话不存在" });
		const goal = request.body?.goal;
		if (!goal || !goal.trim()) return reply.code(400).send({ error: "goal is required" });
		// 上下文:增量游标压缩(thread_summaries.message_seq_until 只处理新消息,旧摘要注入;超 token 阈值才压缩中间)
		const built = buildContextForThread(deps.db, request.tenantId, thread.id, { goal });
		let history = built.messages.map((m) => ({ role: m.role as AgentMessage["role"], content: stripChartsForHistory(m.content) })) as AgentMessage[];
		
		// "接管原生 HTTP 响应"、用来做流式输出
		// reply.hijack(); —— 接管响应，Fastify 别再插手
		reply.hijack();
		reply.raw.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
		reply.raw.setHeader("Cache-Control", "no-cache");
		// 告诉浏览器/中间层不要缓存这个响应。
		// 因为是实时流，缓存了就没意义（甚至有害）。
		// 注意：no-cache 不是"不缓存"，而是"每次用前都要向服务器验证"。真正的"完全不存"是 no-store。但这里意图就是避免拿到旧数据。

		reply.raw.setHeader("X-Accel-Buffering", "no");
		// reply.raw.setHeader("X-Accel-Buffering", "no") —— 关闭 Nginx 缓冲

		const write = (obj: unknown) => reply.raw.write(JSON.stringify(obj) + "\n");

		// 客户端中断:连接关闭(关页面/断网/用户取消)时触发 agent 取消,不再继续执行/落库
		const abortController = new AbortController();
		let clientGone = false;
		const onClientClose = () => { clientGone = true; abortController.abort(); setStopSignal(thread.id).catch(() => undefined); };
		request.raw.once("close", onClientClose);
		try {
			const result = await runSalesAgentWithPlan(
				{ db: deps.db, tenantId: request.tenantId, store: deps.store, runtime: deps.runtime, streamFn: deps.streamFn },
				{ goal, history, threadId: thread.id, signal: abortController.signal, onProgress: (e: unknown) => write(e) },
			);
			appendThreadMessage(deps.db, request.tenantId, thread.id, "user", [{ type: "text", text: goal }]);
			// 运行期间客户端已断开:不落库、不写流,直接收尾
			if (clientGone) { reply.raw.destroy(); return reply; }
			if (result.final?.answer) {
				appendThreadMessage(deps.db, request.tenantId, thread.id, "assistant", [{ type: "text", text: result.final.answer }]);
			}
			if (!thread.title) {
				const t = goal.replace(/\s+/g, " ").trim();
				setThreadTitle(deps.db, request.tenantId, thread.id, t.length > 24 ? t.slice(0, 24) + "…" : t);
			}
			try {
				ensureThreadSummary(deps.db, request.tenantId, thread.id);
			} catch (error) {
				console.warn(`[context] 摘要落库失败: ${error instanceof Error ? error.message : String(error)}`);
			}
			clearStopSignal(thread.id).catch(() => undefined);
			write({ type: "final", threadId: thread.id, runId: result.runId, final: result.final });
			request.raw.removeListener("close", onClientClose);
			reply.raw.end();
		} catch (error) {
			request.raw.removeListener("close", onClientClose);
			if (abortController.signal.aborted) {
				// 客户端已中断:尝试通知前端(连接可能已断,写失败忽略)
				try { write({ type: "cancelled", reason: "client_disconnected" }); reply.raw.end(); } catch { reply.raw.destroy(); }
			} else {
				write({ type: "error", error: error instanceof Error ? error.message : String(error) });
				reply.raw.end();
			}
		}
		return reply;
	});

	// 多代理汇总:前端轮询看板确认子任务全部完成后调用,协调者读看板生成最终答复
	app.post<{ Params: { id: string }; Body: { runId?: string } }>("/api/v1/agent/threads/:id/multi-summary", async (request, reply) => {
		const thread = getThread(deps.db, request.tenantId, request.params.id);
		if (!thread) return reply.code(404).send({ error: "thread_not_found", message: "会话不存在" });
		const runId = request.body?.runId;
		const plan = runId ? getAgentPlanByRun(deps.db, request.tenantId, runId) : undefined;
		if (!plan) return reply.code(400).send({ error: "plan_not_found", message: "未找到该会话的执行计划" });
		const goal = plan.goal;
		const result = await collectMultiAgentFlow(
			{ db: deps.db, tenantId: request.tenantId, store: deps.store, runtime: deps.runtime, streamFn: deps.streamFn },
			{ goal, threadId: thread.id },
			JSON.parse(plan.planJson),
		);
		return { final: result.final ?? null };
	});

	app.post<{ Params: { name: string }; Body: { params?: Record<string, unknown> } }>("/api/v1/agent/tools/:name/page", async (request, reply) => {
		try {
			return await executeToolPage({ db: deps.db, tenantId: request.tenantId }, request.params.name, request.body?.params ?? {});
		} catch (error) {
			return reply.code(400).send({ error: "tool_page_failed", message: error instanceof Error ? error.message : String(error) });
		}
	});

	app.get<{ Params: { runId: string } }>("/api/v1/agent/:runId/timeline", async (request) => {
		const events = listAgentEvents(deps.db, request.tenantId, request.params.runId);
		return { runId: request.params.runId, events };
	});

	app.get<{ Params: { runId: string } }>("/api/v1/agent/:runId/steps", async (request) => {
		const rows = listAgentEvents(deps.db, request.tenantId, request.params.runId);
		const steps = [];
		for (const e of rows) {
			if (e.eventType !== "tool_start" && e.eventType !== "tool_end") continue;
			let summary = "";
			if (e.payloadJson) {
				try {
					const p = JSON.parse(e.payloadJson);
					if (e.eventType === "tool_start") {
						summary = JSON.stringify(p);
					} else {
						const txt = Array.isArray(p?.content) ? p.content.map((c: any) => c?.text ?? "").join(" ").trim() : "";
						summary = txt || JSON.stringify(p);
					}
				} catch {
					summary = e.payloadJson;
				}
			}
			let details: unknown;
			if (e.eventType === "tool_end" && e.payloadJson) {
				try {
					details = JSON.parse(e.payloadJson);
				} catch {
					details = undefined;
				}
			}
			steps.push({ seq: e.seq, eventType: e.eventType, toolName: e.toolName, summary, details });
		}
		return { runId: request.params.runId, steps };
	});
}
