import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface AgentPlan {
	id: string;
	runId: string;
	tenantId: string;
	goal: string;
	planJson: string;
	status: "planned" | "executed" | "verified" | "failed";
	executedToolsJson: string | null;
	verificationJson: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface PlanStep {
	step: string;
	tool: string;
	purpose: string;
}

export interface PlanDetails {
	summary?: string;
	steps: PlanStep[];
}

export function recordAgentPlan(
	db: DatabaseSync,
	input: { runId: string; tenantId: string; goal: string; plan: PlanDetails; status?: AgentPlan["status"] },
): AgentPlan {
	const id = randomUUID();
	db.prepare(
		"INSERT INTO agent_plans (id, run_id, tenant_id, goal, plan_json, status) VALUES (?,?,?,?,?,?)",
	).run(id, input.runId, input.tenantId, input.goal, JSON.stringify(input.plan), input.status ?? "planned");
	return db.prepare("SELECT * FROM agent_plans WHERE id = ?").get(id) as unknown as AgentPlan;
}

export function getAgentPlanByRun(db: DatabaseSync, tenantId: string, runId: string): AgentPlan | undefined {
	const row = db
		.prepare("SELECT * FROM agent_plans WHERE tenant_id = ? AND run_id = ? ORDER BY created_at DESC LIMIT 1")
		.get(tenantId, runId) as Record<string, unknown> | undefined;
	return row ? mapRow(row) : undefined;
}

export function updateAgentPlan(
	db: DatabaseSync,
	tenantId: string,
	runId: string,
	patch: { status?: AgentPlan["status"]; executedTools?: string[]; verification?: unknown },
): AgentPlan | undefined {
	const existing = getAgentPlanByRun(db, tenantId, runId);
	if (!existing) return undefined;
	db.prepare(
		"UPDATE agent_plans SET status = ?, executed_tools_json = ?, verification_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
	).run(patch.status ?? existing.status, patch.executedTools ? JSON.stringify(patch.executedTools) : existing.executedToolsJson, patch.verification !== undefined ? JSON.stringify(patch.verification) : existing.verificationJson, existing.id);
	return getAgentPlanByRun(db, tenantId, runId);
}

function mapRow(row: Record<string, unknown>): AgentPlan {
	return {
		id: String(row.id),
		runId: String(row.run_id),
		tenantId: String(row.tenant_id),
		goal: String(row.goal),
		planJson: String(row.plan_json),
		status: String(row.status) as AgentPlan["status"],
		executedToolsJson: row.executed_tools_json ? String(row.executed_tools_json) : null,
		verificationJson: row.verification_json ? String(row.verification_json) : null,
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}