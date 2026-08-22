import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ModelRuntime } from "./pi/models.js";
import { ingestDocument } from "./services/ingest.js";
import { requireTenant, upsertCustomer } from "./repositories/customers.js";
import { createAnalysis, listAnalysesByCustomer } from "./repositories/analyses.js";
import { runCopilotAnalysis } from "./pi/copilot.js";
import type { SessionStore } from "./pi/sessions.js";

export interface RouteDeps {
	db: DatabaseSync;
	store: SessionStore;
	runtime?: ModelRuntime;
	streamFn?: StreamFn;
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
		return { analysisId: saved.id, conversationId: result.conversationId, analysis: saved };
	});

	app.get<{ Params: { key: string } }>("/api/v1/customers/:key/analyses", async (request) => {
		const customer = upsertCustomer(deps.db, { tenantId: request.tenantId, key: request.params.key });
		return { analyses: listAnalysesByCustomer(deps.db, request.tenantId, customer.id) };
	});
}