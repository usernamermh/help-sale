import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { ModelRuntime } from "./pi/models.js";
import { ingestDocument, ingestEntries } from "./services/ingest.js";
import { searchKnowledge } from "./repositories/knowledge.js";
import { normalizeAnalyzeMessages, type ConversationMessage } from "./services/conversation.js";
import { requireTenant, upsertCustomer } from "./repositories/customers.js";
import { bindAnalysisRequestHash, createAnalysis, findAnalysisByRequestHash, listAnalysesByCustomer } from "./repositories/analyses.js";
import { createTask, getTask, listTasks, setTaskStatus } from "./repositories/tasks.js";
import { createVehiclePlan, listVehiclePlansByCustomer } from "./repositories/vehicle-plans.js";
import { createDigest, getDigestByDate, listDigests } from "./repositories/digests.js";
import { collectDigest } from "./services/digest.js";
import { collectInsights } from "./services/insights.js";
import { collectImprovements } from "./services/improvements.js";
import { refreshCustomerTags } from "./services/customer-tags.js";
import { listCustomerTags } from "./repositories/customer-tags.js";
import { runResponseEvaluation } from "./pi/evaluator.js";
import { runVoiceDigest } from "./pi/voice-digest.js";
import { notifyOverdue } from "./services/notifications.js";
import { listNotificationLogs } from "./repositories/notification-logs.js";
import { getConversation, listConversations, upsertConversation } from "./repositories/conversations.js";
import { fetchTranscript } from "./pi/sessions.js";
import { config } from "./env.js";
import { approveCandidate, createCandidate, listCandidates, rejectCandidate } from "./repositories/knowledge-candidates.js";
import { listAgentEvents } from "./repositories/agent-events.js";
import { runVehicleMatch } from "./pi/vehicle-advisor.js";
import type { MysqlSink } from "./integrations/mysql-sink.js";
import type { ReminderQueue } from "./integrations/reminder-queue.js";
import { runCopilotAnalysis } from "./pi/copilot.js";
import { replaceConversationMessages, listConversationMessages as listConvMessages, type ConversationMessageRow } from "./repositories/conversation-data.js";
import { createDeal, getSalespersonById, getStore, getStoreManager, getStoreOverview, listDeals, listSales, listStores, upsertSalesperson, upsertStore } from "./repositories/store-ops.js";
import { analysisRequestHash } from "./services/analysis-cache.js";
import { runSalesAgent } from "./pi/agent-runtime.js";
import { CAPABILITIES, getCapabilityDef } from "./pi/capabilities.js";
import { createWorkflow, listCapabilityStates, listWorkflows, setCapabilityEnabled } from "./repositories/agent-capabilities.js";
import { queryConsoleLogs } from "./services/console-logs.js";
import { executeToolPage } from "./services/tool-pagination.js";
import { appendThreadMessage, createThread, deleteAllThreads, deleteThread, getThread, listThreadMessages, listThreads, setThreadTitle } from "./repositories/agent-threads.js";
import type { SessionStore } from "./pi/sessions.js";

export interface RouteDeps {
	db: DatabaseSync;
	store: SessionStore;
	dataDir: string;
	runtime?: ModelRuntime;
	streamFn?: StreamFn;
	mysqlSink?: MysqlSink;
	reminders: ReminderQueue;
}


export interface VehicleRequirements {
	budgetMin?: number;
	budgetMax?: number;
	seats?: number;
	energyType?: string;
	bodyType?: string;
	usage?: string;
	notes?: string;
}

function buildVehicleRequirementsText(r: VehicleRequirements): string {
	const parts: string[] = ["客户购车需求:"];
	if (r.budgetMin !== undefined || r.budgetMax !== undefined) {
		parts.push(`预算 ${r.budgetMin ?? "不限"}-${r.budgetMax ?? "不限"} 万元`);
	}
	if (r.seats) parts.push(`座位数 ${r.seats}`);
	if (r.energyType) parts.push(`能源类型 ${r.energyType}`);
	if (r.bodyType) parts.push(`级别 ${r.bodyType}`);
	if (r.usage) parts.push(`主要用途 ${r.usage}`);
	if (r.notes) parts.push(`补充说明 ${r.notes}`);
	return parts.join(";");
}


interface SalesContext {
	salesName?: string;
	salesId?: string;
	salesPhone?: string;
	storeId?: string;
}

function pickStr(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** 从请求体与请求头解析销售/门店上下文(body 优先,兼容 x-sales-* 头)。 */
function salesContextFrom(body: Record<string, unknown> | undefined, headers: Record<string, string | string[] | undefined>): SalesContext {
	const b = body ?? {};
	return {
		salesName: pickStr(b.salesName ?? headers["x-sales-name"]),
		salesId: pickStr(b.salesId ?? headers["x-sales-id"]),
		salesPhone: pickStr(b.salesPhone ?? headers["x-sales-phone"]),
		storeId: pickStr(b.storeId ?? headers["x-store-id"]),
	};
}

/** 店长数据范围:带 x-sales-id 且角色为 manager 时,只能访问所属门店;越权返回 denied。 */
async function resolveManagerScope(
	db: DatabaseSync,
	tenantId: string,
	headers: Record<string, string | string[] | undefined>,
	requestedStoreId?: string,
): Promise<{ storeId?: string; denied?: boolean }> {
	const salesId = pickStr(headers["x-sales-id"]);
	if (!salesId) return { storeId: requestedStoreId };
	const sale = getSalespersonById(db, tenantId, salesId);
	if (!sale || sale.role !== "manager") return { storeId: requestedStoreId };
	if (requestedStoreId && requestedStoreId !== sale.store_id) return { denied: true };
	return { storeId: sale.store_id ?? undefined };
}

function messageRowsToPayload(rows: ConversationMessageRow[]): Array<{ seq: number; speakerRole: string; speakerName: string | null; content: string; spokenAt: string | null }> {
	return rows.map((r) => ({
		seq: r.seq,
		speakerRole: r.speaker_role,
		speakerName: r.speaker_name,
		content: r.content,
		spokenAt: r.spoken_at,
	}));
}

/** 把对话原文按 角色/内容(可带时间)写入 conversation_messages,缺时间由仓库生成近似值。 */
function persistTranscript(
	db: DatabaseSync,
	tenantId: string,
	conversationId: string,
	messages: Array<{ role: string; content: string; spokenAt?: string; speakerName?: string }>,
	names: { customerName?: string; salesName?: string },
): number {
	return replaceConversationMessages(db, tenantId, conversationId, messages.map((m) => ({
		speakerRole: m.role,
		speakerName: m.speakerName ?? (m.role === "customer" ? (names.customerName ?? "客户") : m.role === "sales" ? (names.salesName ?? "销售") : "其他"),
		content: m.content,
		spokenAt: m.spokenAt,
	})));
}
/** 有销售标识时同步 sales 台账(门店/姓名/电话),返回解析后的销售上下文。 */
function resolveSalesperson(db: DatabaseSync, tenantId: string, sales: SalesContext): SalesContext {
	if (!sales.salesId) return sales;
	const sp = upsertSalesperson(db, tenantId, { storeId: sales.storeId, name: sales.salesName ?? "未知销售", phone: sales.salesPhone, role: "sales" });
	return { salesName: sp.name, salesId: sp.id, salesPhone: sp.phone ?? undefined, storeId: sp.store_id ?? undefined };
}export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
	app.addHook("preHandler", async (request) => {
		requireTenant(deps.db, request.tenantId, "API 租户");
	});


	app.get("/api/v1/health", async () => ({ status: "ok", ts: Date.now() }));
	// 分析执行 + 落库 + 请求级缓存(相同对话原文+上下文直接复用,不调模型)
	async function runAndPersistAnalysis(
		request: { tenantId: string },
		input: {
			messages: ConversationMessage[];
			customerKey?: string;
			customerName?: string;
			customerPhone?: string;
			conversationId?: string;
			sales: SalesContext;
		},
	): Promise<{ status?: number; body?: Record<string, unknown> }> {
		const { db, store, runtime, streamFn } = deps;
		const tenantId = request.tenantId;
		const requestHash = analysisRequestHash({
			messages: input.messages.map((m) => ({ role: m.role, content: m.content, spokenAt: m.spokenAt })),
			customerKey: input.customerKey,
			customerName: input.customerName,
			customerPhone: input.customerPhone,
			salesId: input.sales.salesId,
			salesName: input.sales.salesName,
			salesPhone: input.sales.salesPhone,
			storeId: input.sales.storeId,
			conversationId: input.conversationId,
		});
		const cached = findAnalysisByRequestHash(db, tenantId, requestHash);
		if (cached) {
			const customer = upsertCustomer(db, {
				tenantId,
				key: input.customerKey ?? `c_${randomUUID().slice(0, 8)}`,
				name: input.customerName,
				phone: input.customerPhone,
			});
			if (listConvMessages(db, tenantId, cached.conversationId).length === 0) {
				persistTranscript(db, tenantId, cached.conversationId, input.messages, { customerName: input.customerName, salesName: input.sales.salesName });
			}
			upsertConversation(db, {
				id: cached.conversationId,
				tenantId,
				customerId: customer.id,
				salesName: input.sales.salesName,
				salesId: input.sales.salesId,
				salesPhone: input.sales.salesPhone,
				storeId: input.sales.storeId,
				followupAdvice: cached.nextSteps[0] ?? null,
				messageCount: input.messages.length,
			});
			return {
				body: {
					analysisId: cached.id,
					conversationId: cached.conversationId,
					analysis: cached,
					cached: true,
					transcript: messageRowsToPayload(listConvMessages(db, tenantId, cached.conversationId)),
				},
			};
		}

		const result = await runCopilotAnalysis({ db, tenantId, store, runtime, streamFn }, { messages: input.messages, customerKey: input.customerKey });
		if (!result.details) return { status: 502, body: { error: "agent produced no analysis" } };

		const customer = upsertCustomer(db, {
			tenantId,
			key: input.customerKey ?? `c_${randomUUID().slice(0, 8)}`,
			name: input.customerName,
			phone: input.customerPhone,
		});

		// 有销售标识时同步 sales 台账,并把门店归属带到会话
		let sales = input.sales;
		if (input.sales.salesId) {
			const sp = upsertSalesperson(db, tenantId, {
				storeId: input.sales.storeId,
				name: input.sales.salesName ?? "未知销售",
				phone: input.sales.salesPhone,
				role: "sales",
			});
			sales = { salesName: sp.name, salesId: sp.id, salesPhone: sp.phone ?? undefined, storeId: sp.store_id ?? undefined };
		}

		const saved = createAnalysis(db, {
			tenantId,
			customerId: customer.id,
			conversationId: result.conversationId,
			intent: result.details.intent,
			summary: result.details.summary,
			signals: result.details.signals,
			suggestedReply: result.details.suggestedReply,
			nextSteps: result.details.nextSteps,
			followupAt: result.details.followupAt,
		});

		const firstStep = result.details.nextSteps[0];
		if (result.details.followupAt || firstStep) {
			const task = createTask(db, {
				tenantId,
				customerId: customer.id,
				analysisId: saved.id,
				action: firstStep ?? "跟进客户",
				dueAt: result.details.followupAt,
			});
			const dueMs = task.dueAt ? Date.parse(task.dueAt) : Number.NaN;
			void deps.reminders.add(task.id, Number.isFinite(dueMs) ? dueMs : null);
		}

		refreshCustomerTags(db, {
			tenantId,
			customerId: customer.id,
			analysisId: saved.id,
			intent: saved.intent,
			signals: (saved.signals as Array<{ kind?: string; quote?: string; note?: string }>) ?? [],
		});

		if (result.details.suggestedReply && result.details.suggestedReply.length >= 40) {
			const intent = (saved.intent ?? "通用").slice(0, 40);
			createCandidate(db, {
				tenantId,
				analysisId: saved.id,
				intent,
				draftTitle: `话术·${intent}`.slice(0, 120),
				draftContent: `【适用场景】${saved.summary.slice(0, 120)}\n【话术】${result.details.suggestedReply}`,
			});
		}

		if (deps.mysqlSink) {
			void deps.mysqlSink.appendAnalysis({
				id: saved.id,
				tenantId,
				customerId: customer.id,
				conversationId: saved.conversationId,
				intent: saved.intent,
				summary: saved.summary,
				signalsJson: JSON.stringify(saved.signals),
				suggestedReply: saved.suggestedReply,
				nextStepsJson: JSON.stringify(saved.nextSteps),
				followupAt: saved.followupAt,
				createdAt: saved.createdAt,
			});
		}

		upsertConversation(db, {
			id: result.conversationId,
			tenantId,
			customerId: customer.id,
			salesName: sales.salesName,
			salesId: sales.salesId,
			salesPhone: sales.salesPhone,
			storeId: sales.storeId,
			followupAdvice: firstStep ?? result.details.suggestedReply ?? null,
			messageCount: input.messages.length,
		});
		persistTranscript(db, tenantId, result.conversationId, input.messages, { customerName: input.customerName, salesName: sales.salesName });
		bindAnalysisRequestHash(db, tenantId, saved.id, requestHash);

		return {
			body: {
				analysisId: saved.id,
				conversationId: result.conversationId,
				analysis: saved,
				cached: false,
				transcript: messageRowsToPayload(listConvMessages(db, tenantId, result.conversationId)),
			},
		};
	}

	app.get("/api/v1/agent/capabilities", async (request) => {
		const states = new Map(listCapabilityStates(deps.db, request.tenantId).map((s) => [s.name, s.enabled]));
		return {
			capabilities: CAPABILITIES.map((c) => ({
				name: c.name,
				label: c.label,
				description: c.description,
				category: c.category,
				root: c.root,
				enabled: states.has(c.name) ? states.get(c.name)! : true,
			})),
		};
	});

	app.put<{ Params: { name: string }; Body: { enabled?: boolean } }>("/api/v1/console/capabilities/:name", async (request, reply) => {
		const def = getCapabilityDef(request.params.name);
		if (!def) return reply.code(404).send({ error: "capability_not_found", message: "能力不存在" });
		const enabled = request.body?.enabled !== false;
		setCapabilityEnabled(deps.db, request.tenantId, def.name, enabled);
		return { name: def.name, enabled };
	});

	app.get<{ Querystring: { category?: string; q?: string; limit?: string } }>("/api/v1/console/logs", async (request) => {
		const category = (["all", "runtime", "agent", "notification"].includes(request.query.category ?? "") ? request.query.category : "all") as "all" | "runtime" | "agent" | "notification" | undefined;
		const limit = Number.parseInt(request.query.limit ?? "100", 10);
		const logs = queryConsoleLogs(deps.db, deps.dataDir, {
			tenantId: request.tenantId,
			category,
			q: request.query.q,
			limit: Number.isFinite(limit) ? limit : 100,
		});
		return { logs, count: logs.length };
	});

	app.get("/api/v1/console/workflows", async (request) => {
		return { workflows: listWorkflows(deps.db, request.tenantId) };
	});

	app.post<{ Body: { name?: string; description?: string; steps?: unknown[]; enabled?: boolean } }>("/api/v1/console/workflows", async (request, reply) => {
		const name = request.body?.name?.trim();
		if (!name) return reply.code(400).send({ error: "name is required" });
		const wf = createWorkflow(deps.db, request.tenantId, {
			name,
			description: request.body?.description,
			steps: Array.isArray(request.body?.steps) ? request.body.steps : [],
			enabled: request.body?.enabled,
		});
		return wf;
	});

	app.post<{ Body: { goal?: string; customerKey?: string; conversationId?: string; history?: AgentMessage[] } }>("/api/v1/agent/run", async (request, reply) => {
		const { goal, customerKey, conversationId, history } = request.body ?? {};
		if (!goal || !goal.trim()) return reply.code(400).send({ error: "goal is required" });
		const result = await runSalesAgent(
			{ db: deps.db, tenantId: request.tenantId, store: deps.store, runtime: deps.runtime, streamFn: deps.streamFn },
			{ goal, customerKey, conversationId, history },
		);
	
	return { runId: result.runId, final: result.final, hasResponse: Boolean(result.final) };
	});

	app.post("/api/v1/agent/threads", async (request) => {
		return createThread(deps.db, request.tenantId);
	});

	app.delete("/api/v1/agent/threads", async (request) => {
		const removed = deleteAllThreads(deps.db, request.tenantId);
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
	});	app.get<{ Params: { id: string } }>("/api/v1/agent/threads/:id/export", async (request, reply) => {
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
		return { removed: true };
	});

	app.post<{ Params: { id: string }; Body: { goal?: string } }>("/api/v1/agent/threads/:id/run", async (request, reply) => {
		const thread = getThread(deps.db, request.tenantId, request.params.id);
		if (!thread) return reply.code(404).send({ error: "thread_not_found", message: "会话不存在" });
		const goal = request.body?.goal;
		if (!goal || !goal.trim()) return reply.code(400).send({ error: "goal is required" });
		const prior = listThreadMessages(deps.db, request.tenantId, thread.id);
		const history = prior.filter((m) => m.role === "user" || m.role === "assistant").map((m) => ({ role: m.role, content: m.content })) as AgentMessage[];
		const result = await runSalesAgent(
			{ db: deps.db, tenantId: request.tenantId, store: deps.store, runtime: deps.runtime, streamFn: deps.streamFn },
			{ goal, history },
		);
		appendThreadMessage(deps.db, request.tenantId, thread.id, "user", [{ type: "text", text: goal }]);
		if (result.final?.answer) {
			appendThreadMessage(deps.db, request.tenantId, thread.id, "assistant", [{ type: "text", text: result.final.answer }]);
		}
		if (!thread.title) {
			const t = goal.replace(/\s+/g, " ").trim();
			setThreadTitle(deps.db, request.tenantId, thread.id, t.length > 24 ? t.slice(0, 24) + "…" : t);
		}
		return { threadId: thread.id, runId: result.runId, final: result.final, hasResponse: Boolean(result.final) };
	});

	app.post<{ Params: { id: string }; Body: { goal?: string } }>("/api/v1/agent/threads/:id/run-stream", async (request, reply) => {
		const thread = getThread(deps.db, request.tenantId, request.params.id);
		if (!thread) return reply.code(404).send({ error: "thread_not_found", message: "会话不存在" });
		const goal = request.body?.goal;
		if (!goal || !goal.trim()) return reply.code(400).send({ error: "goal is required" });
		const prior = listThreadMessages(deps.db, request.tenantId, thread.id);
		const history = prior.filter((m) => m.role === "user" || m.role === "assistant").map((m) => ({ role: m.role, content: m.content })) as AgentMessage[];

		reply.hijack();
		reply.raw.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
		reply.raw.setHeader("Cache-Control", "no-cache");
		reply.raw.setHeader("X-Accel-Buffering", "no");
		const write = (obj: unknown) => reply.raw.write(JSON.stringify(obj) + "\n");

		try {
			const result = await runSalesAgent(
				{ db: deps.db, tenantId: request.tenantId, store: deps.store, runtime: deps.runtime, streamFn: deps.streamFn },
				{ goal, history, onProgress: (e) => write(e) },
			);
			appendThreadMessage(deps.db, request.tenantId, thread.id, "user", [{ type: "text", text: goal }]);
			if (result.final?.answer) {
				appendThreadMessage(deps.db, request.tenantId, thread.id, "assistant", [{ type: "text", text: result.final.answer }]);
			}
			if (!thread.title) {
				const t = goal.replace(/\s+/g, " ").trim();
				setThreadTitle(deps.db, request.tenantId, thread.id, t.length > 24 ? t.slice(0, 24) + "…" : t);
			}
			// 打字机流式:最终答复按 6 字符/步逐步下发(delta),节奏可感知,总时长不超过 12s;最终仍发 final 全量事件
			const answer = result.final?.answer ?? "";
			const CHUNK = 6;
			const blocks = Math.max(Math.ceil(answer.length / CHUNK), 1);
			const stepMs = Math.min(48, Math.floor(12000 / blocks));
			for (let i = 0; i < answer.length; i += CHUNK) {
				write({ type: "delta", text: answer.slice(i, i + CHUNK) });
				if (i + CHUNK < answer.length) await new Promise((r) => setTimeout(r, stepMs));
			}
			write({ type: "final", threadId: thread.id, runId: result.runId, final: result.final });
			reply.raw.end();
		} catch (error) {
			write({ type: "error", error: error instanceof Error ? error.message : String(error) });
			reply.raw.end();
		}
		return reply;
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

	app.post<{ Body: { title?: string; content?: string; category?: string } }>("/api/v1/knowledge", async (request, reply) => {
		const { title, content, category } = request.body ?? {};
		if (!title || !content) return reply.code(400).send({ error: "title and content are required" });
		return ingestDocument(deps.db, { tenantId: request.tenantId, title, content, category });
	});

	app.post<{ Body: { category?: string; entries?: Array<{ title: string; content: string }> } }>("/api/v1/knowledge/batch", async (request, reply) => {
		const entries = request.body?.entries;
		if (!entries || entries.length === 0) return reply.code(400).send({ error: "entries are required" });
		if (entries.some((e) => !e.title || !e.content)) return reply.code(400).send({ error: "every entry needs title and content" });
		return { results: ingestEntries(deps.db, { tenantId: request.tenantId, category: request.body?.category, entries }) };
	});
	app.get<{ Querystring: { q?: string; limit?: string } }>("/api/v1/knowledge/search", async (request) => {
		const query = String(request.query.q ?? "").trim();
		const limit = Math.min(Number(request.query.limit ?? 5) || 5, 20);
		return { query, hits: searchKnowledge(deps.db, request.tenantId, query, limit) };
	});

		app.post<{ Body: { transcript?: string; messages?: Array<{ role?: string; content: string; spokenAt?: string; speakerName?: string }>; customerKey?: string; customerName?: string; customerPhone?: string; salesName?: string; salesId?: string; salesPhone?: string; storeId?: string } }>("/api/v1/copilot/analyze", async (request, reply) => {
		const body = request.body ?? {};
		const messages = normalizeAnalyzeMessages({ transcript: body.transcript, messages: body.messages });
		if (messages.length === 0) return reply.code(400).send({ error: "conversation is required", message: "transcript 或 messages 至少提供一个" });
		const out = await runAndPersistAnalysis(request, {
			messages,
			customerKey: body.customerKey,
			customerName: body.customerName,
			customerPhone: body.customerPhone,
			sales: salesContextFrom(body as unknown as Record<string, unknown>, request.headers),
		});
		if (out.status) return reply.code(out.status).send(out.body);
		return out.body;
	});

	app.get<{ Params: { key: string } }>("/api/v1/customers/:key/analyses", async (request) => {
		const customer = upsertCustomer(deps.db, { tenantId: request.tenantId, key: request.params.key });
		return { analyses: listAnalysesByCustomer(deps.db, request.tenantId, customer.id) };
	});
	app.get<{ Querystring: { status?: string; due_before?: string; limit?: string } }>("/api/v1/tasks", async (request) => {
		const status = request.query.status as import("./repositories/tasks.js").TaskStatus | undefined;
		const tasks = listTasks(deps.db, {
			tenantId: request.tenantId,
			status,
			dueBefore: request.query.due_before,
			limit: Number(request.query.limit ?? 50),
		});
		return { tasks };
	});

	app.patch<{ Params: { id: string } }>("/api/v1/tasks/:id/done", async (request, reply) => {
		const task = setTaskStatus(deps.db, request.tenantId, request.params.id, "done");
		if (!task) return reply.code(404).send({ error: "task_not_found", message: "任务不存在" });
		void deps.reminders.remove(task.id);
		return { task };
	});

	app.get("/api/v1/reminders/overdue", async (request) => {
		const ids = await deps.reminders.due(Date.now(), config.remindersTakeLimit);
		const overdue = ids
			.map((id) => getTask(deps.db, request.tenantId, id))
			.filter((task): task is NonNullable<typeof task> => !!task && task.status === "pending");
		return { overdue, generatedAt: new Date().toISOString() };
	});

	app.post<{ Body: { customerKey?: string; requirements?: VehicleRequirements } }>("/api/v1/copilot/vehicle-match", async (request, reply) => {
		const req = request.body?.requirements;
		if (!req) return reply.code(400).send({ error: "invalid_request", message: "requirements is required" });
		const customerKey = request.body?.customerKey ?? `v_${randomUUID().slice(0, 8)}`;
		const customer = upsertCustomer(deps.db, { tenantId: request.tenantId, key: customerKey });
		const requirementsText = buildVehicleRequirementsText(req);
		const result = await runVehicleMatch(
			{ db: deps.db, tenantId: request.tenantId, store: deps.store, runtime: deps.runtime, streamFn: deps.streamFn },
			{ requirementsText, customerKey },
		);
		if (!result.details) return reply.code(502).send({ error: "agent produced no plan" });
		const plan = createVehiclePlan(deps.db, {
			tenantId: request.tenantId,
			customerId: customer.id,
			conversationId: result.conversationId,
			requirement: JSON.stringify(req),
			planJson: JSON.stringify(result.details),
		});
		if (deps.mysqlSink) {
			void deps.mysqlSink.appendVehiclePlan({
				id: plan.id,
				tenantId: request.tenantId,
				customerId: customer.id,
				conversationId: plan.conversationId,
				requirement: JSON.stringify(req),
				planJson: JSON.stringify(result.details),
				createdAt: plan.createdAt,
			});
		}
		return { planId: plan.id, conversationId: result.conversationId, plan: result.details };
	});


	app.get<{ Params: { key: string } }>("/api/v1/customers/:key/tags", async (request) => {
		const customer = upsertCustomer(deps.db, { tenantId: request.tenantId, key: request.params.key });
		return { customerKey: request.params.key, tags: listCustomerTags(deps.db, request.tenantId, customer.id) };
	});

	app.get<{ Params: { key: string } }>("/api/v1/customers/:key/vehicle-plans", async (request) => {
		const customer = upsertCustomer(deps.db, { tenantId: request.tenantId, key: request.params.key });
		const rows = listVehiclePlansByCustomer(deps.db, request.tenantId, customer.id);
		return {
			plans: rows.map((r) => ({
				id: r.id,
				createdAt: r.createdAt,
				requirement: JSON.parse(r.requirement) as unknown,
				plan: JSON.parse(r.planJson) as unknown,
			})),
		};
	});



	app.get<{ Querystring: { days?: string } }>("/api/v1/assistant/improvements", async (request) => {
		const days = Number(request.query.days ?? 30) || 30;
		return collectImprovements(deps.db, { tenantId: request.tenantId, days });
	});
	app.get<{ Querystring: { days?: string } }>("/api/v1/assistant/insights", async (request) => {
		const days = Number(request.query.days ?? config.insightsDays) || config.insightsDays;
		return collectInsights(deps.db, { tenantId: request.tenantId, days });
	});
	app.post("/api/v1/assistant/digest", async (request, reply) => {
		const output = collectDigest(deps.db, { tenantId: request.tenantId });
		const existing = getDigestByDate(deps.db, request.tenantId, output.stats.date);
		if (existing) {
			return {
				digestId: existing.id,
				reused: true,
				title: existing.title,
				content: existing.content,
				stats: JSON.parse(existing.statsJson) as unknown,
				createdAt: existing.createdAt,
			};
		}
		const record = createDigest(deps.db, {
			tenantId: request.tenantId,
			digestDate: output.stats.date,
			title: output.title,
			content: output.content,
			statsJson: JSON.stringify(output.stats),
		});
		return { digestId: record.id, reused: false, title: output.title, content: output.content, stats: output.stats, createdAt: record.createdAt };
	});

	app.get("/api/v1/assistant/digests", async (request, reply) => {
		const rows = listDigests(deps.db, request.tenantId);
		return {
			digests: rows.map((r) => ({
				id: r.id,
				digestDate: r.digestDate,
				title: r.title,
				content: r.content,
				stats: JSON.parse(r.statsJson) as unknown,
				createdAt: r.createdAt,
			})),
		};
	});


	app.get<{ Querystring: { status?: string } }>("/api/v1/knowledge/candidates", async (request) => {
		const status = request.query.status as "pending" | "approved" | "rejected" | undefined;
		return { candidates: listCandidates(deps.db, request.tenantId, status, config.knowledgeCandidatesLimit) };
	});

	app.post<{ Params: { id: string } }>("/api/v1/knowledge/candidates/:id/approve", async (request, reply) => {
		const candidate = approveCandidate(deps.db, request.tenantId, request.params.id);
		if (!candidate) return reply.code(404).send({ error: "candidate_not_found", message: "候选不存在" });
		return { candidate };
	});

	app.post<{ Params: { id: string } }>("/api/v1/knowledge/candidates/:id/reject", async (request, reply) => {
		const candidate = rejectCandidate(deps.db, request.tenantId, request.params.id);
		if (!candidate) return reply.code(404).send({ error: "candidate_not_found", message: "候选不存在" });
		return { candidate };
	});


	app.post<{ Body: { conversation?: string; reply?: string } }>("/api/v1/copilot/evaluate-response", async (request, reply) => {
		const conversation = String(request.body?.conversation ?? "").trim();
		const replyText = String(request.body?.reply ?? "").trim();
		if (!conversation || !replyText) {
			return reply.code(400).send({ error: "conversation and reply are required" });
		}
		const result = await runResponseEvaluation(
			{ db: deps.db, tenantId: request.tenantId, store: deps.store, runtime: deps.runtime, streamFn: deps.streamFn },
			{ text: `【客户对话】\n${conversation}\n\n【销售回复】\n${replyText}` },
		);
		if (!result.details) return reply.code(502).send({ error: "agent produced no evaluation" });
		const salesEval = resolveSalesperson(deps.db, request.tenantId, salesContextFrom(request.body as unknown as Record<string, unknown> | undefined, request.headers));
		const evalMsgs = normalizeAnalyzeMessages({ transcript: conversation });
		upsertConversation(deps.db, { id: result.conversationId, tenantId: request.tenantId, salesName: salesEval.salesName, salesId: salesEval.salesId, salesPhone: salesEval.salesPhone, storeId: salesEval.storeId, messageCount: evalMsgs.length });
		persistTranscript(deps.db, request.tenantId, result.conversationId, evalMsgs, { salesName: salesEval.salesName });
		return { conversationId: result.conversationId, evaluation: result.details };
	});


	app.post<{ Body: { transcript?: string } }>("/api/v1/copilot/voice-digest", async (request, reply) => {
		const text = String(request.body?.transcript ?? "").trim();
		if (!text) return reply.code(400).send({ error: "transcript is required" });
		const result = await runVoiceDigest(
			{ db: deps.db, tenantId: request.tenantId, store: deps.store, runtime: deps.runtime, streamFn: deps.streamFn },
			{ text },
		);
		if (!result.details) return reply.code(502).send({ error: "agent produced no digest" });
		const salesDigest = resolveSalesperson(deps.db, request.tenantId, salesContextFrom(request.body as unknown as Record<string, unknown> | undefined, request.headers));
		const digestMsgs = normalizeAnalyzeMessages({ transcript: text });
		upsertConversation(deps.db, { id: result.conversationId, tenantId: request.tenantId, salesName: salesDigest.salesName, salesId: salesDigest.salesId, salesPhone: salesDigest.salesPhone, storeId: salesDigest.storeId, messageCount: digestMsgs.length });
		persistTranscript(deps.db, request.tenantId, result.conversationId, digestMsgs, { salesName: salesDigest.salesName });
		return { conversationId: result.conversationId, digest: result.details };
	});


	app.post("/api/v1/notifications/trigger", async (request, reply) => {
		const result = await notifyOverdue(deps.db, {
			tenantId: request.tenantId,
			reminders: deps.reminders,
			webhookUrl: config.notificationEnabled ? config.notificationWebhookUrl : undefined,
		});
		return reply.send(result);
	});

	app.get("/api/v1/notifications", async (request) => {
		return { logs: listNotificationLogs(deps.db, request.tenantId) };
	});


	// ── 门店管理:门店 / 销售 / 成交 / 经营概览(店长按 x-sales-id 限所属门店) ──
	app.get("/api/v1/stores", async (request) => {
		return { stores: listStores(deps.db, request.tenantId) };
	});

	app.post<{ Body: { name?: string; address?: string; managerName?: string; managerPhone?: string } }>("/api/v1/stores", async (request, reply) => {
		const name = request.body?.name?.trim();
		if (!name) return reply.code(400).send({ error: "store name is required" });
		const store = upsertStore(deps.db, request.tenantId, { name, address: request.body?.address });
		if (request.body?.managerName?.trim()) {
			upsertSalesperson(deps.db, request.tenantId, { storeId: store.id, name: request.body.managerName.trim(), phone: request.body.managerPhone, role: "manager" });
		}
		return { store };
	});

	app.get<{ Params: { id: string } }>("/api/v1/stores/:id", async (request, reply) => {
		const store = getStore(deps.db, request.tenantId, request.params.id);
		if (!store) return reply.code(404).send({ error: "store_not_found", message: "门店不存在" });
		const { manager, sales } = getStoreManager(deps.db, request.tenantId, store.id);
		return { store, manager, sales };
	});

	app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>("/api/v1/stores/:id/overview", async (request, reply) => {
		const store = getStore(deps.db, request.tenantId, request.params.id);
		if (!store) return reply.code(404).send({ error: "store_not_found", message: "门店不存在" });
		const scope = await resolveManagerScope(deps.db, request.tenantId, request.headers, store.id);
		if (scope.denied || (scope.storeId && scope.storeId !== store.id)) {
			return reply.code(403).send({ error: "forbidden", message: "店长只能查看所属门店数据" });
		}
		return getStoreOverview(deps.db, request.tenantId, { storeId: store.id, from: request.query.from, to: request.query.to });
	});

	app.get<{ Querystring: { storeId?: string } }>("/api/v1/sales", async (request) => {
		return { sales: listSales(deps.db, request.tenantId, request.query.storeId) };
	});

	app.post<{ Body: { storeId?: string; name?: string; phone?: string; role?: string } }>("/api/v1/sales", async (request, reply) => {
		const name = request.body?.name?.trim();
		if (!name) return reply.code(400).send({ error: "sales name is required" });
		const salesperson = upsertSalesperson(deps.db, request.tenantId, { storeId: request.body?.storeId, name, phone: request.body?.phone, role: request.body?.role });
		return { salesperson };
	});

	app.get<{ Querystring: { storeId?: string; from?: string; to?: string; limit?: string } }>("/api/v1/deals", async (request, reply) => {
		const scope = await resolveManagerScope(deps.db, request.tenantId, request.headers, request.query.storeId);
		if (scope.denied) return reply.code(403).send({ error: "forbidden", message: "店长只能查看所属门店数据" });
		const limit = Number(request.query.limit ?? config.dealsLimit) || config.dealsLimit;
		return { deals: listDeals(deps.db, request.tenantId, { storeId: scope.storeId, from: request.query.from, to: request.query.to, limit }) };
	});

	app.post<{ Body: { customerKey?: string; salesId?: string; storeId?: string; amount?: number; dealedAt?: string; status?: string } }>("/api/v1/deals", async (request, reply) => {
		const body = request.body ?? {};
		const amount = Number(body.amount);
		if (!body.customerKey?.trim() || !Number.isFinite(amount) || amount <= 0) {
			return reply.code(400).send({ error: "customerKey and amount are required" });
		}
		const customer = upsertCustomer(deps.db, { tenantId: request.tenantId, key: body.customerKey.trim() });
		const salesRow = body.salesId ? getSalespersonById(deps.db, request.tenantId, body.salesId) : undefined;
		if (body.salesId && !salesRow) return reply.code(400).send({ error: "sales_not_found", message: "销售不存在" });
		const storeId = body.storeId ?? salesRow?.store_id ?? null;
		if (!body.salesId && !storeId) return reply.code(400).send({ error: "storeId or salesId is required" });
		const deal = createDeal(deps.db, request.tenantId, {
			storeId: storeId ?? undefined,
			salesId: salesRow?.id ?? body.salesId ?? undefined,
			customerId: customer.id,
			amount,
			dealedAt: body.dealedAt,
			status: body.status,
		});
		return { deal };
	});

	app.get<{ Params: { id: string } }>("/api/v1/conversations/:id/transcript", async (request, reply) => {
		const meta = getConversation(deps.db, request.tenantId, request.params.id);
		if (!meta) return reply.code(404).send({ error: "conversation_not_found", message: "会话不存在" });
		const customer = meta.customerId
			? (deps.db.prepare("SELECT id, key, name, phone FROM customers WHERE id = ?").get(meta.customerId) as unknown as { id: string; key: string; name: string | null; phone: string | null } | undefined)
			: undefined;
		return {
			conversation: meta,
			customer: customer ?? null,
			transcript: messageRowsToPayload(listConvMessages(deps.db, request.tenantId, meta.id)),
		};
	});
	app.get<{ Querystring: { limit?: string } }>("/api/v1/conversations", async (request) => {
		const limit = Math.min(Number(request.query.limit ?? config.conversationsLimit) || config.conversationsLimit, 100);
		return { conversations: listConversations(deps.db, request.tenantId, limit) };
	});

		app.post<{ Params: { id: string } }>("/api/v1/conversations/:id/analyze", async (request, reply) => {
		const meta = getConversation(deps.db, request.tenantId, request.params.id);
		if (!meta) return reply.code(404).send({ error: "conversation_not_found", message: "会话不存在" });
		const dbMessages = listConvMessages(deps.db, request.tenantId, meta.id);
		let messages: ConversationMessage[];
		if (dbMessages.length > 0) {
			messages = dbMessages.map((m) => ({
				role: m.speaker_role === "sales" || m.speaker_role === "customer" || m.speaker_role === "other" ? m.speaker_role : "other",
				content: m.content,
				spokenAt: m.spoken_at ?? undefined,
				speakerName: m.speaker_name ?? undefined,
			}));
		} else {
			const session = await deps.store.openConversation(meta.id);
			const transcript = await fetchTranscript(session, config.transcriptLimit);
			if (transcript.length === 0) return reply.code(422).send({ error: "conversation_empty", message: "会话中无消息" });
			messages = transcript;
		}

		const out = await runAndPersistAnalysis(request, {
			messages,
			customerKey: meta.customerKey ?? `c_${randomUUID().slice(0, 8)}`,
			customerName: meta.customerName ?? undefined,
			conversationId: meta.id,
			sales: { salesName: meta.salesName, salesId: meta.salesId ?? undefined, salesPhone: meta.salesPhone ?? undefined, storeId: meta.storeId ?? undefined },
		});
		if (out.status) return reply.code(out.status).send(out.body);
		return out.body;
	});

	app.get<{ Params: { conversationId: string } }>("/api/v1/conversations/:conversationId/timeline", async (request) => {
		const events = listAgentEvents(deps.db, request.tenantId, request.params.conversationId);
		return {
			conversationId: request.params.conversationId,
			events: events.map((e) => ({
				seq: e.seq,
				type: e.eventType,
				toolName: e.toolName,
				payload: e.payloadJson ? (JSON.parse(e.payloadJson) as unknown) : null,
				createdAt: e.createdAt,
			})),
		};
	});
}
