import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ModelRuntime } from "./pi/models.js";
import { ingestDocument, ingestEntries } from "./services/ingest.js";
import { searchKnowledge } from "./repositories/knowledge.js";
import { normalizeAnalyzeMessages } from "./services/conversation.js";
import { requireTenant, upsertCustomer } from "./repositories/customers.js";
import { createAnalysis, listAnalysesByCustomer } from "./repositories/analyses.js";
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
import { loadConfig } from "./env.js";
import { approveCandidate, createCandidate, listCandidates, rejectCandidate } from "./repositories/knowledge-candidates.js";
import { listAgentEvents } from "./repositories/agent-events.js";
import { runVehicleMatch } from "./pi/vehicle-advisor.js";
import type { MysqlSink } from "./integrations/mysql-sink.js";
import type { ReminderQueue } from "./integrations/reminder-queue.js";
import { runCopilotAnalysis } from "./pi/copilot.js";
import type { SessionStore } from "./pi/sessions.js";

export interface RouteDeps {
	db: DatabaseSync;
	store: SessionStore;
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

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
	app.addHook("preHandler", async (request) => {
		requireTenant(deps.db, request.tenantId, "API 租户");
	});

	app.get("/api/v1/health", async () => ({ status: "ok", ts: Date.now() }));

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

	app.post<{ Body: { transcript?: string; messages?: Array<{ role?: string; content: string }>; customerKey?: string } }>("/api/v1/copilot/analyze", async (request, reply) => {
		const messages = normalizeAnalyzeMessages({ transcript: request.body?.transcript, messages: request.body?.messages });
		if (messages.length === 0) return reply.code(400).send({ error: "conversation is required", message: "transcript 或 messages 至少提供一个" });

		const result = await runCopilotAnalysis(
			{ db: deps.db, tenantId: request.tenantId, store: deps.store, runtime: deps.runtime, streamFn: deps.streamFn },
			{ messages, customerKey: request.body.customerKey },
		);
		if (!result.details) return reply.code(502).send({ error: "agent produced no analysis" });

		const customer = upsertCustomer(deps.db, {
			tenantId: request.tenantId,
			key: request.body.customerKey ?? `c_${randomUUID().slice(0, 8)}`,
		});
		const saved = createAnalysis(deps.db, {
			tenantId: request.tenantId,
			customerId: customer.id,
			conversationId: result.conversationId,
			intent: result.details.intent,
			summary: result.details.summary,
			signals: result.details.signals,
			suggestedReply: result.details.suggestedReply,
			nextSteps: result.details.nextSteps,
			followupAt: result.details.followupAt,
		});

		// loop F3:分析完成后自动生成跟进任务,并进入 Redis 到期提醒队列
		const firstStep = result.details.nextSteps[0];
		if (result.details.followupAt || firstStep) {
			const task = createTask(deps.db, {
				tenantId: request.tenantId,
				customerId: customer.id,
				analysisId: saved.id,
				action: firstStep ?? "跟进客户",
				dueAt: result.details.followupAt,
			});
			const dueMs = task.dueAt ? Date.parse(task.dueAt) : Number.NaN;
			void deps.reminders.add(task.id, Number.isFinite(dueMs) ? dueMs : null);
		}

		// 客户画像标签(zhiji 语义标签):按意图+信号自动聚合
		refreshCustomerTags(deps.db, {
			tenantId: request.tenantId,
			customerId: customer.id,
			analysisId: saved.id,
			intent: saved.intent,
			signals: (saved.signals as Array<{ kind?: string; quote?: string; note?: string }>) ?? [],
		});

		// loop F6:高质量话术自动生成知识沉淀候选
		if (result.details.suggestedReply && result.details.suggestedReply.length >= 40) {
			const intent = (saved.intent ?? "通用").slice(0, 40);
			createCandidate(deps.db, {
				tenantId: request.tenantId,
				analysisId: saved.id,
				intent,
				draftTitle: `话术·${intent}`.slice(0, 120),
				draftContent: `【适用场景】${saved.summary.slice(0, 120)}\n【话术】${result.details.suggestedReply}`,
			});
		}

		// 归档到远程 MySQL(失败自动降级)
		if (deps.mysqlSink) {
			void deps.mysqlSink.appendAnalysis({
				id: saved.id,
				tenantId: request.tenantId,
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

		upsertConversation(deps.db, {
			id: result.conversationId,
			tenantId: request.tenantId,
			customerId: customer.id,
			salesName: (request.headers["x-sales-name"] as string | undefined) ?? "默认销售",
			messageCount: result.messages.filter((m) => (m as { role: string }).role !== "user").length,
		});

		return { analysisId: saved.id, conversationId: result.conversationId, analysis: saved };
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
		const ids = await deps.reminders.due(Date.now(), 100);
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
		const days = Number(request.query.days ?? 7) || 7;
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
		return { candidates: listCandidates(deps.db, request.tenantId, status) };
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
		return { conversationId: result.conversationId, digest: result.details };
	});


	app.post("/api/v1/notifications/trigger", async (request, reply) => {
		const config = loadConfig();
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

	app.get<{ Querystring: { limit?: string } }>("/api/v1/conversations", async (request) => {
		const limit = Math.min(Number(request.query.limit ?? 30) || 30, 100);
		return { conversations: listConversations(deps.db, request.tenantId, limit) };
	});

	app.post<{ Params: { id: string } }>("/api/v1/conversations/:id/analyze", async (request, reply) => {
		const meta = getConversation(deps.db, request.tenantId, request.params.id);
		if (!meta) return reply.code(404).send({ error: "conversation_not_found", message: "会话不存在" });
		const session = await deps.store.openConversation(meta.id);
		const transcript = await fetchTranscript(session);
		if (transcript.length === 0) return reply.code(422).send({ error: "conversation_empty", message: "会话中无消息" });

		const customer = upsertCustomer(deps.db, { tenantId: request.tenantId, key: meta.customerKey ?? `c_${randomUUID().slice(0, 8)}` });
		const result = await runCopilotAnalysis(
			{ db: deps.db, tenantId: request.tenantId, store: deps.store, runtime: deps.runtime, streamFn: deps.streamFn },
			{ messages: transcript, customerKey: customer.key },
		);
		if (!result.details) return reply.code(502).send({ error: "agent produced no analysis" });

		const saved = createAnalysis(deps.db, {
			tenantId: request.tenantId,
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
			const task = createTask(deps.db, {
				tenantId: request.tenantId,
				customerId: customer.id,
				analysisId: saved.id,
				action: firstStep ?? "跟进客户",
				dueAt: result.details.followupAt,
			});
			const dueMs = task.dueAt ? Date.parse(task.dueAt) : Number.NaN;
			void deps.reminders.add(task.id, Number.isFinite(dueMs) ? dueMs : null);
		}

		refreshCustomerTags(deps.db, {
			tenantId: request.tenantId,
			customerId: customer.id,
			analysisId: saved.id,
			intent: saved.intent,
			signals: (saved.signals as Array<{ kind?: string; quote?: string; note?: string }>) ?? [],
		});

		if (result.details.suggestedReply && result.details.suggestedReply.length >= 40) {
			const intent = (saved.intent ?? "通用").slice(0, 40);
			createCandidate(deps.db, {
				tenantId: request.tenantId,
				analysisId: saved.id,
				intent,
				draftTitle: `话术·${intent}`.slice(0, 120),
				draftContent: `【适用场景】${saved.summary.slice(0, 120)}\n【话术】${result.details.suggestedReply}`,
			});
		}

		if (deps.mysqlSink) {
			void deps.mysqlSink.appendAnalysis({
				id: saved.id,
				tenantId: request.tenantId,
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

		upsertConversation(deps.db, {
			id: result.conversationId,
			tenantId: request.tenantId,
			customerId: customer.id,
			salesName: meta.salesName,
			messageCount: result.messages.filter((m) => (m as { role: string }).role !== "user").length,
		});

		return { analysisId: saved.id, conversationId: result.conversationId, analysis: saved };
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