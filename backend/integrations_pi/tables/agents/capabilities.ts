import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface CapabilityState {
	name: string;
	enabled: boolean;
	updatedAt?: string;
}

export function listCapabilityStates(db: DatabaseSync, tenantId: string): CapabilityState[] {
	const rows = db.prepare("SELECT * FROM agent_capabilities WHERE tenant_id = ?").all(tenantId) as Array<Record<string, unknown>>;
	// 数据库列叫 capability_name，业务对象叫 name
	return rows.map((r) => ({
		name: String(r.capability_name),
		enabled: Number(r.enabled) !== 0,
		updatedAt: r.updated_at ? String(r.updated_at) : undefined,
	}));
}

export function setCapabilityEnabled(db: DatabaseSync, tenantId: string, name: string, enabled: boolean): void {
	db.prepare(
		`INSERT INTO agent_capabilities (tenant_id, capability_name, enabled, updated_at)
		 VALUES (?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
		 ON CONFLICT(tenant_id, capability_name) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
	).run(tenantId, name, enabled ? 1 : 0);
}

export type WorkflowStatus = "draft" | "enabled" | "disabled" | "rejected";
export type WorkflowOrigin = "manual" | "mined";

export interface WorkflowRecord {
	id: string;
	tenantId: string;
	name: string;
	description: string;
	steps: unknown[];
	enabled: boolean;
	version: number;
	status: WorkflowStatus;
	/** 来源:manual=人工/接口预定义,mined=模型执行轨迹挖掘 */
	origin: WorkflowOrigin;
	/** 工具序列签名(如 customer_query→knowledge_search),用于挖掘去重 */
	sourceSignature?: string;
	createdAt: string;
	updatedAt: string;
}

export interface CreateWorkflowInput {
	name: string;
	description?: string;
	steps?: unknown[];
	enabled?: boolean;
	status?: WorkflowStatus;
	origin?: WorkflowOrigin;
	sourceSignature?: string;
}

/** agent 可见的工具名(与 agent-tools.workflowTool 保持一致的命名规则)。 */
export function workflowToolName(workflowId: string): string {
	return "workflow_" + workflowId.replace(/-/g, "").slice(0, 12);
}

export function createWorkflow(db: DatabaseSync, tenantId: string, input: CreateWorkflowInput): WorkflowRecord {
	const id = randomUUID();
	const status = input.status ?? (input.enabled === false ? "disabled" : "enabled");
	db.prepare(
		"INSERT INTO workflows (id, tenant_id, name, description, steps_json, enabled, version, status, origin, source_signature) VALUES (?,?,?,?,?,?,?,?,?,?)",
	).run(
		id,
		tenantId,
		input.name,
		input.description ?? "",
		JSON.stringify(input.steps ?? []),
		status === "enabled" ? 1 : 0,
		1,
		status,
		input.origin ?? "manual",
		input.sourceSignature ?? null,
	);
	return getWorkflow(db, tenantId, id)!;
}

/** 按签名查已存在的工作流(挖掘去重用):命中任一状态即视为已沉淀过。 */
export function findWorkflowBySignature(db: DatabaseSync, tenantId: string, signature: string): WorkflowRecord | undefined {
	const row = db
		.prepare("SELECT * FROM workflows WHERE tenant_id = ? AND source_signature = ? ORDER BY updated_at DESC LIMIT 1")
		.get(tenantId, signature) as Record<string, unknown> | undefined;
	return row ? mapWorkflow(row) : undefined;
}

/** 晋升草稿为可调用工作流(status=enabled);已启用则幂等返回。 */
export function approveWorkflow(db: DatabaseSync, tenantId: string, id: string): WorkflowRecord | undefined {
	return setWorkflowStatus(db, tenantId, id, "enabled");
}

/** 驳回草稿:保留定义但不进入工具列表,同时阻止后续挖掘重复产出。 */
export function rejectWorkflow(db: DatabaseSync, tenantId: string, id: string): WorkflowRecord | undefined {
	return setWorkflowStatus(db, tenantId, id, "rejected");
}

export function setWorkflowStatus(db: DatabaseSync, tenantId: string, id: string, status: WorkflowStatus): WorkflowRecord | undefined {
	const existing = getWorkflow(db, tenantId, id);
	if (!existing) return undefined;
	db.prepare("UPDATE workflows SET status = ?, enabled = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND tenant_id = ?").run(
		status,
		status === "enabled" ? 1 : 0,
		id,
		tenantId,
	);
	return getWorkflow(db, tenantId, id);
}

export function getWorkflow(db: DatabaseSync, tenantId: string, id: string): WorkflowRecord | undefined {
	const row = db.prepare("SELECT * FROM workflows WHERE tenant_id = ? AND id = ?").get(tenantId, id) as Record<string, unknown> | undefined;
	return row ? mapWorkflow(row) : undefined;
}

export function listWorkflows(db: DatabaseSync, tenantId: string): WorkflowRecord[] {
	const rows = db.prepare("SELECT * FROM workflows WHERE tenant_id = ? ORDER BY updated_at DESC").all(tenantId) as Array<Record<string, unknown>>;
	return rows.map(mapWorkflow);
}

/**
 * 更新工作流定义(版本 +1)。
 * 未显式传 status 时:若原状态是 enabled/disabled 则按 enabled 布尔重算,
 * 其余(draft/rejected)保持不变 —— 编辑内容不等于人工晋升。
 */
export function updateWorkflow(db: DatabaseSync, tenantId: string, id: string, input: CreateWorkflowInput): WorkflowRecord | undefined {
	const existing = getWorkflow(db, tenantId, id);
	if (!existing) return undefined;
	let status: WorkflowStatus = input.status ?? existing.status;
	if (!input.status) {
		if (existing.status === "enabled" || existing.status === "disabled") status = input.enabled === false ? "disabled" : "enabled";
	}
	db.prepare(
		"UPDATE workflows SET name = ?, description = ?, steps_json = ?, enabled = ?, version = version + 1, status = ?, origin = ?, source_signature = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND tenant_id = ?",
	).run(
		input.name,
		input.description ?? existing.description,
		JSON.stringify(input.steps ?? existing.steps),
		status === "enabled" ? 1 : 0,
		status,
		input.origin ?? existing.origin,
		input.sourceSignature ?? existing.sourceSignature ?? null,
		id,
		tenantId,
	);
	return getWorkflow(db, tenantId, id);
}

export function deleteWorkflow(db: DatabaseSync, tenantId: string, id: string): boolean {
	const r = db.prepare("DELETE FROM workflows WHERE tenant_id = ? AND id = ?").run(tenantId, id);
	return r.changes > 0;
}

function mapWorkflow(row: Record<string, unknown>): WorkflowRecord {
	let steps: unknown[] = [];
	try {
		steps = JSON.parse(String(row.steps_json ?? "[]"));
	} catch {
		steps = [];
	}
	return {
		id: String(row.id),
		tenantId: String(row.tenant_id),
		name: String(row.name),
		description: String(row.description ?? ""),
		steps,
		enabled: Number(row.enabled) !== 0,
		version: Number(row.version ?? 1),
		status: (row.status ? String(row.status) : "enabled") as WorkflowStatus,
		origin: (row.origin ? String(row.origin) : "manual") as WorkflowOrigin,
		sourceSignature: row.source_signature ? String(row.source_signature) : undefined,
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}