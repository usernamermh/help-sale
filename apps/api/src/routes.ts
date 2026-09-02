import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ModelRuntime } from "./pi/models.js";
import { ingestDocument } from "./services/ingest.js";
import { requireTenant, upsertCustomer } from "./repositories/customers.js";
import { createAnalysis, listAnalysesByCustomer } from "./repositories/analyses.js";
import { createTask, getTask, listTasks, setTaskStatus } from "./repositories/tasks.js";
import { createVehiclePlan, listVehiclePlansByCustomer } from "./repositories/vehicle-plans.js";
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

	app.post<{ Body: { title?: string; content?: string } }>("/api/v1/knowledge", async (request, reply) => {
		const { title, content } = request.body ?? {};
		if (!title || !content) return reply.code(400).send({ error: "title and content are required" });
		return ingestDocument(deps.db, { tenantId: request.tenantId, title, content });
	});

	app.post<{ Body: { transcript?: string; customerKey?: string } }>("/api/v1/copilot/analyze", async (request, reply) => {
		const transcript = request.body?.transcript;
		if (!transcript) return reply.code(400).send({ error: "transcript is required" });

		const result = await runCopilotAnalysis(
			{ db: deps.db, tenantId: request.tenantId, store: deps.store, runtime: deps.runtime, streamFn: deps.streamFn },
			{ transcript, customerKey: request.body.customerKey },
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
}