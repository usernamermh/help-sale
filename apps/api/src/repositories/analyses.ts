import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface AnalysisRecord {
	id: string;
	tenantId: string;
	customerId: string;
	conversationId: string;
	intent: string;
	summary: string;
	signals: unknown[];
	suggestedReply: string;
	nextSteps: string[];
	followupAt?: string;
	createdAt: string;
}

export interface CreateAnalysisInput {
	tenantId: string;
	customerId: string;
	conversationId: string;
	intent: string;
	summary: string;
	signals: unknown[];
	suggestedReply: string;
	nextSteps: string[];
	followupAt?: string;
}

export function createAnalysis(db: DatabaseSync, input: CreateAnalysisInput): AnalysisRecord {
	const id = randomUUID();
	db.prepare(
		`INSERT INTO analyses
		 (id, tenant_id, customer_id, conversation_id, intent, summary, signals_json, suggested_reply, next_steps_json, followup_at)
		 VALUES (?,?,?,?,?,?,?,?,?,?)`,
	).run(
		id,
		input.tenantId,
		input.customerId,
		input.conversationId,
		input.intent,
		input.summary,
		JSON.stringify(input.signals),
		input.suggestedReply,
		JSON.stringify(input.nextSteps),
		input.followupAt ?? null,
	);
	return getAnalysis(db, input.tenantId, id)!;
}

export function getAnalysis(db: DatabaseSync, tenantId: string, id: string): AnalysisRecord | undefined {
	const row = db.prepare("SELECT * FROM analyses WHERE tenant_id = ? AND id = ?").get(tenantId, id) as unknown as
		| {
				id: string;
				tenant_id: string;
				customer_id: string;
				conversation_id: string;
				intent: string;
				summary: string;
				signals_json: string;
				suggested_reply: string;
				next_steps_json: string;
				followup_at: string | null;
				created_at: string;
		  }
		| undefined;
	if (!row) return undefined;
	return {
		id: row.id,
		tenantId: row.tenant_id,
		customerId: row.customer_id,
		conversationId: row.conversation_id,
		intent: row.intent,
		summary: row.summary,
		signals: JSON.parse(row.signals_json),
		suggestedReply: row.suggested_reply,
		nextSteps: JSON.parse(row.next_steps_json),
		followupAt: row.followup_at ?? undefined,
		createdAt: row.created_at,
	};
}

export function listAnalysesByCustomer(db: DatabaseSync, tenantId: string, customerId: string, limit = 20): AnalysisRecord[] {
	const rows = db
		.prepare("SELECT id FROM analyses WHERE tenant_id = ? AND customer_id = ? ORDER BY created_at DESC LIMIT ?")
		.all(tenantId, customerId, limit) as unknown as { id: string }[];
	return rows.map((r) => getAnalysis(db, tenantId, r.id)!);
}

/** 记录分析请求哈希(相同输入下次直接复用,不调模型)。 */
export function bindAnalysisRequestHash(db: DatabaseSync, tenantId: string, analysisId: string, hash: string): void {
	db.prepare("UPDATE analyses SET request_hash = ? WHERE id = ? AND tenant_id = ?").run(hash, analysisId, tenantId);
}

export function findAnalysisByRequestHash(db: DatabaseSync, tenantId: string, hash: string): AnalysisRecord | undefined {
	const row = db.prepare("SELECT id FROM analyses WHERE tenant_id = ? AND request_hash = ?").get(tenantId, hash) as unknown as { id: string } | undefined;
	if (!row) return undefined;
	return getAnalysis(db, tenantId, row.id);
}