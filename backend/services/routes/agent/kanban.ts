import { notifySubagentWork } from "./subagent-signal.js";
// 看板卡片存储:多代理协作的 kanban_cards 表读写(原 v1 services/kanban-store.ts)
import type { DatabaseSync } from "node:sqlite";

/** 看板卡片(多代理协作通信总线,SQLite 存储)。 */
export interface KanbanCard {
	id: string;
	tenantId: string;
	threadId: string;
	title: string;
	description?: string;
	status: string; // pending | inprogress | done | error
	goal?: string;
	tools?: string[];
	result?: string;
	error?: string;
	/** 是否允许本批子代理看到其他子代理的最新结果(主 agent 建卡时按选项写入) */
	shareEnabled?: boolean;
	/** 领取者实例(多实例竞争凭据);未领取为空 */
	ownerInstance?: string;
	/** 领取租约到期时间(ISO);过期后其他实例可接管 */
	leaseExpiresAt?: string;
	/** 已尝试执行次数(超过上限直接判 error,避免坏卡无限重试) */
	attempts: number;
	createdAt: string;
	updatedAt: string;
}

function mapRow(row: Record<string, unknown>): KanbanCard {
	return {
		id: String(row.id),
		tenantId: String(row.tenant_id),
		threadId: String(row.thread_id),
		title: String(row.title),
		description: row.description ? String(row.description) : undefined,
		status: String(row.status),
		goal: row.goal ? String(row.goal) : undefined,
		tools: row.tools_json ? JSON.parse(String(row.tools_json)) as string[] : undefined,
		result: row.result ? String(row.result) : undefined,
		error: row.error ? String(row.error) : undefined,
		shareEnabled: Number(row.share_enabled ?? 0) === 1,
		ownerInstance: row.owner_instance ? String(row.owner_instance) : undefined,
		leaseExpiresAt: row.lease_expires_at ? String(row.lease_expires_at) : undefined,
		attempts: Number(row.attempts ?? 0),
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}

/** 清空指定会话的看板(该会话新任务开始时调用,只影响当前会话)。 */
export function resetKanban(db: DatabaseSync, tenantId: string, threadId: string): void {
	db.prepare("DELETE FROM kanban_cards WHERE tenant_id = ? AND thread_id = ?").run(tenantId, threadId);
}

/** 删除会话时一并清理该会话的看板记录。 */
export function removeKanbanByThread(db: DatabaseSync, tenantId: string, threadId: string): void {
	resetKanban(db, tenantId, threadId);
}

/** 创建任务卡片:threadId 表示所属会话。 */
export function createKanbanTask(db: DatabaseSync, input: { tenantId: string; threadId: string; title: string; goal: string; description?: string; tools?: string[]; status?: string; shareEnabled?: boolean }): KanbanCard {
	const id = `K${Date.now()}${Math.floor(Math.random() * 1000)}`;
	const now = new Date().toISOString();
	db.prepare(
		"INSERT INTO kanban_cards (id, tenant_id, thread_id, title, description, status, goal, tools_json, share_enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
	).run(id, input.tenantId, input.threadId, input.title, input.description ?? null, input.status ?? "pending", input.goal, input.tools ? JSON.stringify(input.tools) : null, input.shareEnabled === true ? 1 : 0, now, now);
	const created = getKanbanCard(db, input.tenantId, id)!;
	// 有新任务进 pending 就唤醒消费者(而不是等下一次轮询)
	if (created.status === "pending") notifySubagentWork();
	return created;
}

/** 读取卡片。 */
export function getKanbanCard(db: DatabaseSync, tenantId: string, id: string): KanbanCard | undefined {
	const row = db.prepare("SELECT * FROM kanban_cards WHERE tenant_id = ? AND id = ?").get(tenantId, id) as Record<string, unknown> | undefined;
	return row ? mapRow(row) : undefined;
}

/** 列出卡片:threadId 缺省返回全部,传了则只返回该会话的卡片。 */
export function listKanbanCards(db: DatabaseSync, tenantId: string, opts?: { status?: string; threadId?: string }): KanbanCard[] {
	let sql = "SELECT * FROM kanban_cards WHERE tenant_id = ?";
	const params: Array<string> = [tenantId];
	if (opts?.status) { sql += " AND status = ?"; params.push(opts.status); }
	if (opts?.threadId) { sql += " AND thread_id = ?"; params.push(opts.threadId); }
	sql += " ORDER BY created_at ASC";
	const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
	return rows.map(mapRow);
}

/** 更新卡片字段。 */
export function updateKanbanCard(db: DatabaseSync, tenantId: string, id: string, patch: Partial<KanbanCard>): KanbanCard | undefined {
	const card = getKanbanCard(db, tenantId, id);
	if (!card) return undefined;
	const next = { ...card, ...patch, id: card.id, tenantId: card.tenantId, threadId: card.threadId, createdAt: card.createdAt, updatedAt: new Date().toISOString() };
	db.prepare(
		"UPDATE kanban_cards SET title = ?, description = ?, status = ?, goal = ?, tools_json = ?, result = ?, error = ?, share_enabled = ?, owner_instance = ?, lease_expires_at = ?, attempts = ?, updated_at = ? WHERE id = ? AND tenant_id = ?",
	).run(next.title, next.description ?? null, next.status, next.goal ?? null, next.tools ? JSON.stringify(next.tools) : null, next.result ?? null, next.error ?? null, next.shareEnabled === true ? 1 : 0, next.ownerInstance ?? null, next.leaseExpiresAt ?? null, next.attempts ?? 0, next.updatedAt, id, tenantId);
	const saved = getKanbanCard(db, tenantId, id);
	// 卡片被改回 pending(重试/重新排队)同样要唤醒消费者
	if (saved?.status === "pending") notifySubagentWork();
	return saved;
}

/** 心跳:刷新卡片 updated_at(供主代理监督子代理是否仍在执行)。 */
export function touchKanbanCard(db: DatabaseSync, tenantId: string, id: string): void {
	db.prepare("UPDATE kanban_cards SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND tenant_id = ?").run(id, tenantId);
}

/** 把运行中的子代理标记为 inprogress;返回 false 表示卡片不存在。 */
/**
 * 原子领取:只有"把这张卡从 pending 改成 inprogress"成功的那一个执行者才算抢到。
 * 靠 UPDATE 的条件与影响行数保证互斥 —— 多实例同时扫到同一张卡时,只有一个 changes=1。
 */
export function claimKanbanCard(db: DatabaseSync, tenantId: string, id: string, opts: { owner: string; leaseMs: number }): boolean {
	const now = new Date();
	const result = db
		.prepare(
			"UPDATE kanban_cards SET status = 'inprogress', owner_instance = ?, lease_expires_at = ?, attempts = attempts + 1, updated_at = ? WHERE id = ? AND tenant_id = ? AND status = 'pending'",
		)
		.run(opts.owner, new Date(now.getTime() + opts.leaseMs).toISOString(), now.toISOString(), id, tenantId);
	return Number(result.changes ?? 0) === 1;
}

/** 心跳续租:执行中的卡定期刷新租约,避免被别的实例当成过期接管。 */
export function renewKanbanLease(db: DatabaseSync, tenantId: string, id: string, owner: string, leaseMs: number): boolean {
	const result = db
		.prepare("UPDATE kanban_cards SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND owner_instance = ? AND status = 'inprogress'")
		.run(new Date(Date.now() + leaseMs).toISOString(), new Date().toISOString(), id, tenantId, owner);
	return Number(result.changes ?? 0) === 1;
}

/**
 * 回收过期租约:领取者崩了/卡死了,租约到期就把卡放回 pending 让别人接手;
 * 尝试次数超过上限则直接判 error,避免坏卡被无限重试。
 */
export function reclaimExpiredKanbanCards(db: DatabaseSync, tenantId: string, opts: { maxAttempts: number }): number {
	const now = new Date().toISOString();
	const expired = db
		.prepare("UPDATE kanban_cards SET status = 'pending', owner_instance = NULL, lease_expires_at = NULL, updated_at = ? WHERE tenant_id = ? AND status = 'inprogress' AND lease_expires_at IS NOT NULL AND lease_expires_at < ? AND attempts < ?")
		.run(now, tenantId, now, opts.maxAttempts);
	const gaveUp = db
		.prepare("UPDATE kanban_cards SET status = 'error', error = '子代理多次执行未完成,已放弃', owner_instance = NULL, lease_expires_at = NULL, updated_at = ? WHERE tenant_id = ? AND status = 'inprogress' AND lease_expires_at IS NOT NULL AND lease_expires_at < ? AND attempts >= ?")
		.run(now, tenantId, now, opts.maxAttempts);
	return Number(expired.changes ?? 0) + Number(gaveUp.changes ?? 0);
}

/** 回填子代理执行结果:ok=true 置 done+result,否则 error+error。 */
export function finishKanbanCard(db: DatabaseSync, tenantId: string, id: string, input: { ok: boolean; result?: string; error?: string }): KanbanCard | undefined {
	return updateKanbanCard(db, tenantId, id, {
		status: input.ok ? "done" : "error",
		result: input.ok ? input.result : undefined,
		error: input.ok ? undefined : input.error,
		// 执行结束:清掉领取归属与租约
		ownerInstance: undefined,
		leaseExpiresAt: undefined,
	});
}
