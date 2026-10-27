import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface ThreadSummary {
	id: string;
	tenantId: string;
	threadId: string;
	summary: string;
	messageSeqUntil: number;
	createdAt: string;
	updatedAt: string;
}

export function upsertThreadSummary(
	db: DatabaseSync,
	input: { tenantId: string; threadId: string; summary: string; messageSeqUntil: number },
): ThreadSummary {
	const existing = getThreadSummary(db, input.tenantId, input.threadId);
	if (existing) {
		db.prepare(
			"UPDATE thread_summaries SET summary = ?, message_seq_until = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
		).run(input.summary, input.messageSeqUntil, existing.id);
		return getThreadSummary(db, input.tenantId, input.threadId)!;
	}
	const id = randomUUID();
	db.prepare(
		"INSERT INTO thread_summaries (id, tenant_id, thread_id, summary, message_seq_until) VALUES (?,?,?,?,?)",
	).run(id, input.tenantId, input.threadId, input.summary, input.messageSeqUntil);
	return getThreadSummary(db, input.tenantId, input.threadId)!;
}

export function getThreadSummary(db: DatabaseSync, tenantId: string, threadId: string): ThreadSummary | undefined {
	const row = db
		.prepare("SELECT * FROM thread_summaries WHERE tenant_id = ? AND thread_id = ?")
		.get(tenantId, threadId) as Record<string, unknown> | undefined;
	return row ? mapRow(row) : undefined;
}

function mapRow(row: Record<string, unknown>): ThreadSummary {
	return {
		id: String(row.id),
		tenantId: String(row.tenant_id),
		threadId: String(row.thread_id),
		summary: String(row.summary),
		messageSeqUntil: Number(row.message_seq_until ?? 0),
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}