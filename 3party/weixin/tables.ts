import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/** weixin_users / weixin_messages 的读写(两张表都在 backend/db/schema.sql 里)。 */

export interface WeixinUserRow {
	id: string;
	tenantId: string;
	openid: string;
	nickname: string | null;
	boundKind: string | null;
	boundId: string | null;
	threadId: string | null;
	lastActiveAt: string | null;
	createdAt: string;
}

function mapUser(row: Record<string, unknown>): WeixinUserRow {
	return {
		id: String(row.id),
		tenantId: String(row.tenant_id),
		openid: String(row.openid),
		nickname: row.nickname === null || row.nickname === undefined ? null : String(row.nickname),
		boundKind: row.bound_kind === null || row.bound_kind === undefined ? null : String(row.bound_kind),
		boundId: row.bound_id === null || row.bound_id === undefined ? null : String(row.bound_id),
		threadId: row.thread_id === null || row.thread_id === undefined ? null : String(row.thread_id),
		lastActiveAt: row.last_active_at === null || row.last_active_at === undefined ? null : String(row.last_active_at),
		createdAt: String(row.created_at),
	};
}

export function getWeixinUser(db: DatabaseSync, tenantId: string, openid: string): WeixinUserRow | undefined {
	const row = db.prepare("SELECT * FROM weixin_users WHERE tenant_id = ? AND openid = ?").get(tenantId, openid) as Record<string, unknown> | undefined;
	return row ? mapUser(row) : undefined;
}

/** 第一次见到这个微信联系人时建档;已存在则只刷新活跃时间。 */
export function ensureWeixinUser(db: DatabaseSync, tenantId: string, openid: string, nickname?: string): WeixinUserRow {
	const existing = getWeixinUser(db, tenantId, openid);
	if (existing) {
		db.prepare("UPDATE weixin_users SET last_active_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE tenant_id = ? AND openid = ?").run(tenantId, openid);
		return { ...existing, lastActiveAt: new Date().toISOString() };
	}
	db.prepare("INSERT INTO weixin_users (id, tenant_id, openid, nickname, last_active_at) VALUES (?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))").run(
		randomUUID(),
		tenantId,
		openid,
		nickname ?? null,
	);
	return getWeixinUser(db, tenantId, openid)!;
}

export function setWeixinThread(db: DatabaseSync, tenantId: string, openid: string, threadId: string): void {
	db.prepare("UPDATE weixin_users SET thread_id = ? WHERE tenant_id = ? AND openid = ?").run(threadId, tenantId, openid);
}

export function bindWeixinUser(db: DatabaseSync, tenantId: string, openid: string, boundKind: string, boundId: string): boolean {
	const result = db.prepare("UPDATE weixin_users SET bound_kind = ?, bound_id = ? WHERE tenant_id = ? AND openid = ?").run(boundKind, boundId, tenantId, openid);
	return Number(result.changes ?? 0) > 0;
}

export function listWeixinUsers(db: DatabaseSync, tenantId: string, limit: number): WeixinUserRow[] {
	const rows = db
		.prepare("SELECT * FROM weixin_users WHERE tenant_id = ? ORDER BY COALESCE(last_active_at, created_at) DESC LIMIT ?")
		.all(tenantId, Math.max(1, Math.min(limit, 200))) as Record<string, unknown>[];
	return rows.map(mapUser);
}

export interface WeixinMessageInput {
	tenantId: string;
	openid: string;
	direction: "in" | "out";
	messageId?: string;
	msgType: string;
	content: string;
	threadId?: string;
	runId?: string;
	status: string;
	error?: string;
}

export function recordWeixinMessage(db: DatabaseSync, input: WeixinMessageInput): void {
	db.prepare(
		"INSERT INTO weixin_messages (id, tenant_id, openid, direction, message_id, msg_type, content, thread_id, run_id, status, error, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
	).run(
		randomUUID(),
		input.tenantId,
		input.openid,
		input.direction,
		input.messageId ?? null,
		input.msgType,
		input.content.slice(0, 4000),
		input.threadId ?? null,
		input.runId ?? null,
		input.status,
		input.error ?? null,
	);
}

/** 同一条 iLink 消息只处理一次(重放/重投递时直接跳过)。 */
export function isMessageRecorded(db: DatabaseSync, tenantId: string, messageId: string): boolean {
	if (!messageId) return false;
	const row = db
		.prepare("SELECT id FROM weixin_messages WHERE tenant_id = ? AND direction = 'in' AND message_id = ? LIMIT 1")
		.get(tenantId, messageId) as { id?: string } | undefined;
	return Boolean(row?.id);
}

export function listWeixinMessages(db: DatabaseSync, tenantId: string, limit: number): Array<Record<string, unknown>> {
	return db
		.prepare("SELECT * FROM weixin_messages WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?")
		.all(tenantId, Math.max(1, Math.min(limit, 200))) as Array<Record<string, unknown>>;
}
export interface WeixinThreadRow {
	threadId: string;
	title: string;
	lastActiveAt: string | null;
}

/** 会话目录:一个联系人可以有多个会话(/sessions 列出来、/switch 切过去)。 */
export function upsertWeixinThread(db: DatabaseSync, tenantId: string, openid: string, threadId: string, title?: string): void {
	const existing = db
		.prepare("SELECT id FROM weixin_threads WHERE tenant_id = ? AND openid = ? AND thread_id = ?")
		.get(tenantId, openid, threadId) as { id?: string } | undefined;
	if (existing?.id) {
		if (title) db.prepare("UPDATE weixin_threads SET title = ?, last_active_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE tenant_id = ? AND openid = ? AND thread_id = ?").run(title, tenantId, openid, threadId);
		else db.prepare("UPDATE weixin_threads SET last_active_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE tenant_id = ? AND openid = ? AND thread_id = ?").run(tenantId, openid, threadId);
		return;
	}
	db.prepare("INSERT INTO weixin_threads (id, tenant_id, openid, thread_id, title, last_active_at) VALUES (?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))").run(
		randomUUID(),
		tenantId,
		openid,
		threadId,
		title ?? null,
	);
}

export function listWeixinThreads(db: DatabaseSync, tenantId: string, openid: string, limit: number): WeixinThreadRow[] {
	const rows = db
		.prepare("SELECT thread_id, title, last_active_at FROM weixin_threads WHERE tenant_id = ? AND openid = ? ORDER BY COALESCE(last_active_at, created_at) DESC LIMIT ?")
		.all(tenantId, openid, Math.max(1, Math.min(limit, 50))) as Array<Record<string, unknown>>;
	return rows.map((row) => ({
		threadId: String(row.thread_id),
		title: row.title === null || row.title === undefined ? "" : String(row.title),
		lastActiveAt: row.last_active_at === null || row.last_active_at === undefined ? null : String(row.last_active_at),
	}));
}