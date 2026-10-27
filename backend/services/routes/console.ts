// console.ts(由 v1 routes/prepare.ts 迁移)
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { CAPABILITIES, findWorkflowByCapabilityName, getCapabilityDef, listWorkflowCapabilities } from "../../integrations_pi/capabilities.js";
import { listCapabilityStates, setCapabilityEnabled, setWorkflowStatus } from "../../integrations_pi/tables/agents/capabilities.js";
import { queryConsoleLogs } from "../console-logs.js";
import { listWorkflows, createWorkflow } from "../../integrations_pi/tables/agents/capabilities.js";
import { ingestDocument, ingestEntries } from "../ingest.js";
import { searchKnowledge } from "../../integrations_pi/tables/knowledge/documents.js";
import { upsertCustomer } from "../../integrations_pi/tables/crm/customers.js";

import { listCustomerTags } from "../../integrations_pi/tables/crm/customer-tags.js";
import { config } from "../../env.js";
import type { RouteDeps } from "./helpers.js";
import { checkWorkflowSteps, loadStepToolNames, type WorkflowStep } from "./workflows.js";

export function registerConsoleRoutes(app: FastifyInstance, deps: RouteDeps): void {
	// 能力清单 = 目录工具(静态) + 已沉淀工作流(动态);工作流再按 origin 区分模型挖掘/人工预定义
	app.get("/api/v1/agent/capabilities", async (request) => {
		const rows = listCapabilityStates(deps.db, request.tenantId);
		const pairs = rows.map((s): [string, boolean] => [s.name, s.enabled]);
		const states = new Map(pairs);
		const workflowCaps = listWorkflowCapabilities(deps.db, request.tenantId);
		return {
			capabilities: [
				...CAPABILITIES.filter((c) => !c.hidden).map((c) => ({
					name: c.name,
					label: c.label,
					description: c.description,
					category: c.category,
					root: c.root,
					kind: c.kind ?? "tool",
					origin: c.origin,
					status: c.status,
					enabled: states.has(c.name) ? states.get(c.name)! : true,
				})),
				...workflowCaps.map((c) => ({
					...c,
					// 工作流的开关状态直接由 status 决定(单一真相源,不另存 agent_capabilities)
					enabled: c.status === "enabled",
				})),
			],
		};
	});


	app.put<{ Params: { name: string }; Body: { enabled?: boolean } }>("/api/v1/console/capabilities/:name", async (request, reply) => {
		const enabled = request.body?.enabled !== false;
		// 工作流:开关落在 workflows.status(启用 ↔ 停用);草稿/驳回状态不由这里跨越
		const wf = findWorkflowByCapabilityName(deps.db, request.tenantId, request.params.name);
		if (wf) {
			if (!enabled && wf.status !== "enabled") return reply.code(400).send({ error: "workflow_not_enabled", message: "该工作流尚未晋升为可调用状态" });
			if (enabled && wf.status !== "disabled") return reply.code(400).send({ error: "workflow_not_disabled", message: "该工作流当前不是停用状态(草稿请走审批)" });
			const next = setWorkflowStatus(deps.db, request.tenantId, wf.id, enabled ? "enabled" : "disabled");
			return { name: request.params.name, enabled, kind: "workflow", status: next?.status };
		}
		const def = getCapabilityDef(request.params.name);
		if (!def) return reply.code(404).send({ error: "capability_not_found", message: "能力不存在" });
		setCapabilityEnabled(deps.db, request.tenantId, def.name, enabled);
		return { name: def.name, enabled, kind: "tool" };
	});

	app.get<{ Querystring: { category?: string; q?: string; limit?: string } }>("/api/v1/console/logs", async (request) => {
		const category = (["all", "runtime", "agent", "notification"].includes(request.query.category ?? "") ? request.query.category : "all") as "all" | "runtime" | "agent" | "notification" | undefined;
		const limit = Number.parseInt(request.query.limit ?? "100", 10);
		const logs = queryConsoleLogs(deps.db, deps.logDir, {
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
		const steps = Array.isArray(request.body?.steps) ? (request.body.steps as WorkflowStep[]) : [];
		// 工具存在性校验:人工预定义与模型挖掘走同一套检查,引用了未加载工具的工作流永远跑不起来,
		// 必须在保存时就挡住(此前只有挖掘产出与晋升两个入口校验,手工建的工作流要等模型调用才发现坏掉)
		const check = checkWorkflowSteps(steps, await loadStepToolNames(request.tenantId));
		if (!check.ok) {
			return reply.code(400).send({
				error: "workflow_steps_invalid",
				message: `工作流步骤校验未通过:${check.issues.map((i) => `[${i.stepName}] ${i.message}`).join("; ")}`,
				unknownTools: check.unknownTools,
				issues: check.issues,
			});
		}
		const wf = createWorkflow(deps.db, request.tenantId, {
			name,
			description: request.body?.description,
			steps,
			enabled: request.body?.enabled,
		});
		return wf;
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
	app.get<{ Params: { key: string } }>("/api/v1/customers/:key/tags", async (request) => {
		const customer = upsertCustomer(deps.db, { tenantId: request.tenantId, key: request.params.key });
		return { customerKey: request.params.key, tags: listCustomerTags(deps.db, request.tenantId, customer.id) };
	});

}
