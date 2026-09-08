import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface AgentThreadRecord {
	id: string;
	tenantId: string;
	title: string;
	createdAt: string;
	updatedAt: string;
}

export interface AgentThreadMessageRecord {
	id: string;
	tenantId: string;
	threadId: string;
	seq: number;
	role: "user" | "assistant" | "toolResult";
	contentJson: string;
	content: unknown[];
	createdAt: string;
}

export function createThread(db: DatabaseSync, tenantId: string, title = ""): AgentThreadRecord {
	const id = randomUUID();
	db.prepare("INSERT INTO agent_threads (id, tenant_id, title) VALUES (?,?,?)").run(id, tenantId, title);
	return getThread(db, tenantId, id)!;
}

export function getThread(db: DatabaseSync, tenantId: string, id: string): AgentThreadRecord | undefined {
	const row = db.prepare("SELECT * FROM agent_threads WHERE tenant_id = ? AND id = ?").get(tenantId, id) as Record<string, unknown> | undefined;
	return row ? mapThread(row) : undefined;
}

export function listThreads(db: DatabaseSync, tenantId: string, limit: number): AgentThreadRecord[] {
	const rows = db.prepare("SELECT * FROM agent_threads WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT ?").all(tenantId, Math.min(limit, 100)) as Record<string, unknown>[];
	return rows.map(mapThread);
}

export function setThreadTitle(db: DatabaseSync, tenantId: string, id: string, title: string): void {
	db.prepare("UPDATE agent_threads SET title = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE tenant_id = ? AND id = ?").run(title, tenantId, id);
}

export function appendThreadMessage(
	db: DatabaseSync,
	tenantId: string,
	threadId: string,
	role: AgentThreadMessageRecord["role"],
	content: unknown[],
): AgentThreadMessageRecord {
	const id = randomUUID();
	const seqRow = db.prepare("SELECT COALESCE(MAX(seq),0) AS m FROM agent_thread_messages WHERE tenant_id = ? AND thread_id = ?").get(tenantId, threadId) as { m: number };
	const seq = seqRow.m + 1;
	db.prepare("INSERT INTO agent_thread_messages (id, tenant_id, thread_id, seq, role, content_json) VALUES (?,?,?,?,?,?)").run(
		id,
		tenantId,
		threadId,
		seq,
		role,
		JSON.stringify(content),
	);
	db.prepare("UPDATE agent_threads SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE tenant_id = ? AND id = ?").run(tenantId, threadId);
	return getThreadMessage(db, tenantId, id)!;
}

export function getThreadMessage(db: DatabaseSync, tenantId: string, id: string): AgentThreadMessageRecord | undefined {
	const row = db.prepare("SELECT * FROM agent_thread_messages WHERE tenant_id = ? AND id = ?").get(tenantId, id) as Record<string, unknown> | undefined;
	return row ? mapMessage(row) : undefined;
}

export function listThreadMessages(db: DatabaseSync, tenantId: string, threadId: string): AgentThreadMessageRecord[] {
	const rows = db
		.prepare("SELECT * FROM agent_thread_messages WHERE tenant_id = ? AND thread_id = ? ORDER BY seq ASC")
		.all(tenantId, threadId) as Record<string, unknown>[];
	return rows.map(mapMessage);
}

function mapThread(row: Record<string, unknown>): AgentThreadRecord {
	return {
		id: String(row.id),
		tenantId: String(row.tenant_id),
		title: String(row.title ?? ""),
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}

function mapMessage(row: Record<string, unknown>): AgentThreadMessageRecord {
	const contentJson = String(row.content_json ?? "[]");
	let content: unknown[] = [];
	try {
		content = JSON.parse(contentJson);
	} catch {
		content = [];
	}
	return {
		id: String(row.id),
		tenantId: String(row.tenant_id),
		threadId: String(row.thread_id),
		seq: Number(row.seq),
		role: String(row.role) as AgentThreadMessageRecord["role"],
		contentJson,
		content,
		createdAt: String(row.created_at),
	};
}

/** 清空某租户全部线程(历史会话一键清理):先删消息,再删线程,返回删除线程数。 */
export function deleteAllThreads(db: DatabaseSync, tenantId: string): number {
	const rows = db.prepare("SELECT id FROM agent_threads WHERE tenant_id = ?").all(tenantId) as unknown as Array<{ id: string }>;
	for (const row of rows) {
		db.prepare("DELETE FROM agent_thread_messages WHERE tenant_id = ? AND thread_id = ?").run(tenantId, row.id);
	}
	const result = db.prepare("DELETE FROM agent_threads WHERE tenant_id = ?").run(tenantId);
	return Number(result.changes ?? 0);
}

/** 删除单个线程(先删消息,再删线程);不存在返回 false。 */
export function deleteThread(db: DatabaseSync, tenantId: string, id: string): boolean {
	const row = db.prepare("SELECT id FROM agent_threads WHERE tenant_id = ? AND id = ?").get(tenantId, id);
	if (!row) return false;
	db.prepare("DELETE FROM agent_thread_messages WHERE tenant_id = ? AND thread_id = ?").run(tenantId, id);
	db.prepare("DELETE FROM agent_threads WHERE tenant_id = ? AND id = ?").run(tenantId, id);
	return true;
}