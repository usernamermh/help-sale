import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 看板卡片(与 tools_system/kanban 的卡片结构一致,供消费者/工具共用)。 */
export interface KanbanCard {
	id: string;
	tenantId: string;
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

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** 看板文件:data/kanban-<tenantId>.json;测试用 KANBAN_FILE 重定向(仅当未设置 KANBAN_TENANT 时按租户分文件)。 */
export function kanbanFile(tenantId: string): string {
	if (process.env.KANBAN_FILE) return process.env.KANBAN_FILE;
	return path.join(repoRoot, "data", `kanban-${tenantId}.json`);
}

export function loadKanban(tenantId: string): { items: KanbanCard[]; nextId: number } {
	const file = kanbanFile(tenantId);
	if (!existsSync(file)) return { items: [], nextId: 1 };
	try { return JSON.parse(readFileSync(file, "utf8")) as { items: KanbanCard[]; nextId: number }; } catch { return { items: [], nextId: 1 }; }
}

export function saveKanban(tenantId: string, board: { items: KanbanCard[]; nextId: number }): void {
	const file = kanbanFile(tenantId);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(board, null, 2), "utf8");
}

/** 创建任务卡片:供主代理多 agent 模式与 subagents 工具使用。 */
export function createKanbanTask(input: { tenantId: string; title: string; goal: string; description?: string; tools?: string[]; status?: string }): KanbanCard {
	const board = loadKanban(input.tenantId);
	const now = new Date().toISOString();
	const card: KanbanCard = {
		id: `K${board.nextId++}`,
		tenantId: input.tenantId,
		title: input.title,
		description: input.description,
		status: input.status ?? "pending",
		goal: input.goal,
		tools: input.tools,
		createdAt: now,
		updatedAt: now,
	};
	board.items.push(card);
	saveKanban(input.tenantId, board);
	return card;
}

/** 读取卡片。 */
export function getKanbanCard(tenantId: string, id: string): KanbanCard | undefined {
	return loadKanban(tenantId).items.find((c) => c.id === id);
}

/** 列出卡片(可按状态过滤)。 */
export function listKanbanCards(tenantId: string, status?: string): KanbanCard[] {
	const items = loadKanban(tenantId).items;
	return items.filter((c) => !status || c.status === status).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** 更新卡片字段。 */
export function updateKanbanCard(tenantId: string, id: string, patch: Partial<KanbanCard>): KanbanCard | undefined {
	const board = loadKanban(tenantId);
	const card = board.items.find((c) => c.id === id);
	if (!card) return undefined;
	const next: KanbanCard = { ...card, ...patch, id: card.id, tenantId: card.tenantId, createdAt: card.createdAt, updatedAt: new Date().toISOString() };
	board.items = board.items.map((c) => (c.id === id ? next : c));
	saveKanban(tenantId, board);
	return next;
}

/** 把运行中的子代理标记为 inprogress;返回 false 表示卡片不存在。 */
export function claimKanbanCard(tenantId: string, id: string): boolean {
	const board = loadKanban(tenantId);
	const card = board.items.find((c) => c.id === id);
	if (!card) return false;
	card.status = "inprogress";
	card.updatedAt = new Date().toISOString();
	saveKanban(tenantId, board);
	return true;
}

/** 回填子代理执行结果:ok=true 置 done+result,否则 error+error。 */
export function finishKanbanCard(tenantId: string, id: string, input: { ok: boolean; result?: string; error?: string }): KanbanCard | undefined {
	return updateKanbanCard(tenantId, id, {
		status: input.ok ? "done" : "error",
		result: input.ok ? input.result : undefined,
		error: input.ok ? undefined : input.error,
	});
}