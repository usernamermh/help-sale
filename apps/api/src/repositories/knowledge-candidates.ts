import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ingestDocument } from "../services/ingest.js";

export type CandidateStatus = "pending" | "approved" | "rejected";

export interface CandidateRecord {
	id: string;
	tenantId: string;
	analysisId: string;
	intent: string;
	draftTitle: string;
	draftContent: string;
	status: CandidateStatus;
	createdAt: string;
	approvedAt: string | null;
	documentId?: string;
}

export function createCandidate(
	db: DatabaseSync,
	input: { tenantId: string; analysisId: string; intent: string; draftTitle: string; draftContent: string },
): CandidateRecord {
	const id = randomUUID();
	db.prepare(
		"INSERT INTO knowledge_candidates (id, tenant_id, analysis_id, intent, draft_title, draft_content) VALUES (?,?,?,?,?,?)",
	).run(id, input.tenantId, input.analysisId, input.intent, input.draftTitle, input.draftContent);
	return getCandidate(db, input.tenantId, id)!;
}

export function getCandidate(db: DatabaseSync, tenantId: string, id: string): CandidateRecord | undefined {
	const row = db
		.prepare("SELECT * FROM knowledge_candidates WHERE tenant_id = ? AND id = ?")
		.get(tenantId, id) as Record<string, unknown> | undefined;
	return row ? mapRow(row) : undefined;
}

export function listCandidates(db: DatabaseSync, tenantId: string, status: CandidateStatus | undefined, limit: number): CandidateRecord[] {
	const rows = status
		? (db
				.prepare(
					"SELECT * FROM knowledge_candidates WHERE tenant_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?",
				)
				.all(tenantId, status, limit) as Record<string, unknown>[])
		: (db
				.prepare("SELECT * FROM knowledge_candidates WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?")
				.all(tenantId, limit) as Record<string, unknown>[]);
	return rows.map(mapRow);
}

/** 确认入库:复用标准 ingest(分块/去重/分类),同名文档已存在则跳过新增;候选标记 approved。 */
export function approveCandidate(db: DatabaseSync, tenantId: string, candidateId: string): CandidateRecord | undefined {
	const existing = getCandidate(db, tenantId, candidateId);
	if (!existing) return undefined;
	if (existing.status === "approved") return existing;

	const result = ingestDocument(db, {
		tenantId,
		title: existing.draftTitle,
		content: existing.draftContent,
		category: existing.intent || undefined,
	});
	db.prepare(
		"UPDATE knowledge_candidates SET status = 'approved', approved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
	).run(candidateId);

	const record = getCandidate(db, tenantId, candidateId)!;
	return { ...record, documentId: result.documentId };
}

export function rejectCandidate(db: DatabaseSync, tenantId: string, candidateId: string): CandidateRecord | undefined {
	const existing = getCandidate(db, tenantId, candidateId);
	if (!existing) return undefined;
	db.prepare("UPDATE knowledge_candidates SET status = 'rejected' WHERE id = ?").run(candidateId);
	return getCandidate(db, tenantId, candidateId);
}

function mapRow(row: Record<string, unknown>): CandidateRecord {
	return {
		id: String(row.id),
		tenantId: String(row.tenant_id),
		analysisId: String(row.analysis_id),
		intent: String(row.intent),
		draftTitle: String(row.draft_title),
		draftContent: String(row.draft_content),
		status: String(row.status) as CandidateStatus,
		createdAt: String(row.created_at),
		approvedAt: row.approved_at ? String(row.approved_at) : null,
	};
}