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
export function createKanbanTask(db: DatabaseSync, input: { tenantId: string; threadId: string; title: string; goal: string; description?: string; tools?: string[]; status?: string }): KanbanCard {
	const id = `K${Date.now()}${Math.floor(Math.random() * 1000)}`;
	const now = new Date().toISOString();
	db.prepare(
		"INSERT INTO kanban_cards (id, tenant_id, thread_id, title, description, status, goal, tools_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
	).run(id, input.tenantId, input.threadId, input.title, input.description ?? null, input.status ?? "pending", input.goal, input.tools ? JSON.stringify(input.tools) : null, now, now);
	return getKanbanCard(db, input.tenantId, id)!;
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
		"UPDATE kanban_cards SET title = ?, description = ?, status = ?, goal = ?, tools_json = ?, result = ?, error = ?, updated_at = ? WHERE id = ? AND tenant_id = ?",
	).run(next.title, next.description ?? null, next.status, next.goal ?? null, next.tools ? JSON.stringify(next.tools) : null, next.result ?? null, next.error ?? null, next.updatedAt, id, tenantId);
	return getKanbanCard(db, tenantId, id);
}

/** 把运行中的子代理标记为 inprogress;返回 false 表示卡片不存在。 */
export function claimKanbanCard(db: DatabaseSync, tenantId: string, id: string): boolean {
	return updateKanbanCard(db, tenantId, id, { status: "inprogress" }) !== undefined;
}

/** 回填子代理执行结果:ok=true 置 done+result,否则 error+error。 */
export function finishKanbanCard(db: DatabaseSync, tenantId: string, id: string, input: { ok: boolean; result?: string; error?: string }): KanbanCard | undefined {
	return updateKanbanCard(db, tenantId, id, {
		status: input.ok ? "done" : "error",
		result: input.ok ? input.result : undefined,
		error: input.ok ? undefined : input.error,
	});
}