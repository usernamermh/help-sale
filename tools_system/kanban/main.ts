import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface ToolContext { db: any; tenantId: string; }

export interface KanbanCard {
	id: string;
	tenantId: string;
	title: string;
	description?: string;
	status: string; // pending | inprogress | done | error
	goal?: string;       // 子代理任务目标(multi-agent 模式)
	tools?: string[];    // 子代理可用工具白名单
	result?: string;     // 子代理执行结果
	error?: string;
	createdAt: string;
	updatedAt: string;
}

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// 按租户隔离看板:data/kanban-<tenant>.json;测试可用 KANBAN_FILE 重定向
function boardFile(tenantId: string): string {
	if (process.env.KANBAN_FILE) return process.env.KANBAN_FILE;
	return path.join(repoRoot, "data", `kanban-${tenantId}.json`);
}

function loadBoard(file: string): { items: KanbanCard[]; nextId: number } {
	if (!existsSync(file)) return { items: [], nextId: 1 };
	try { return JSON.parse(readFileSync(file, "utf8")) as { items: KanbanCard[]; nextId: number }; } catch { return { items: [], nextId: 1 }; }
}
function saveBoard(file: string, board: { items: KanbanCard[]; nextId: number }): void {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(board, null, 2), "utf8");
}

function cardText(c: KanbanCard): string {
	const parts = [`[${c.status}] ${c.id} ${c.title}`];
	if (c.description) parts.push(`- ${c.description}`);
	if (c.goal) parts.push(`目标:${c.goal}`);
	if (c.result) parts.push(`结果:${c.result.length > 80 ? c.result.slice(0, 80) + "…" : c.result}`);
	if (c.error) parts.push(`错误:${c.error}`);
	return parts.join(" ");
}

export function execute(ctx: ToolContext, params: any) {
	const op = String(params?.op ?? "list");
	const tenantId = ctx.tenantId || "t_default";
	const file = boardFile(tenantId);
	const board = loadBoard(file);
	const now = new Date().toISOString();

	if (op === "add") {
		const title = String(params?.title ?? "").trim();
		if (!title) return { content: [{ type: "text", text: "add 需要 title。" }] };
		const id = `K${board.nextId++}`;
		const card: KanbanCard = {
			id, tenantId, title,
			description: params?.description ? String(params.description) : undefined,
			status: params?.status ? String(params.status) : "pending",
			goal: params?.goal ? String(params.goal) : undefined,
			tools: Array.isArray(params?.tools) ? params.tools.map((s: unknown) => String(s)) : undefined,
			createdAt: now, updatedAt: now,
		};
		board.items.push(card);
		saveBoard(file, board);
		return { content: [{ type: "text", text: `已添加卡片 ${id}: ${title}` }], details: { id, card } };
	}

	if (op === "list") {
		const filter = params?.statusFilter ? String(params.statusFilter) : undefined;
		const items = board.items.filter((c) => !filter || c.status === filter);
		const text = items.length ? items.map(cardText).join("\n") : "(看板为空)";
		return { content: [{ type: "text", text: `看板(${items.length} 张卡片):\n${text}` }], details: { items } };
	}

	if (op === "get") {
		const id = String(params?.id ?? "");
		const card = board.items.find((c) => c.id === id);
		if (!card) return { content: [{ type: "text", text: `未找到卡片 ${id}` }] };
		return { content: [{ type: "text", text: JSON.stringify(card) }], details: { card } };
	}

	if (op === "move") {
		const id = String(params?.id ?? "");
		const card = board.items.find((c) => c.id === id);
		if (!card) return { content: [{ type: "text", text: `未找到卡片 ${id}` }] };
		card.status = params?.status ? String(params.status) : "inprogress";
		card.updatedAt = now;
		saveBoard(file, board);
		return { content: [{ type: "text", text: `卡片 ${id} -> ${card.status}` }], details: { card } };
	}

	if (op === "finish") {
		const id = String(params?.id ?? "");
		const card = board.items.find((c) => c.id === id);
		if (!card) return { content: [{ type: "text", text: `未找到卡片 ${id}` }] };
		const ok = params?.ok === false || String(params?.ok ?? "true") === "false" ? false : true;
		card.status = ok ? "done" : "error";
		if (params?.result != null) card.result = String(params.result);
		if (params?.error != null) card.error = String(params.error);
		card.updatedAt = now;
		saveBoard(file, board);
		return { content: [{ type: "text", text: `卡片 ${id} 已${ok ? "完成" : "标记错误"}` }], details: { card } };
	}

	if (op === "remove") {
		const id = String(params?.id ?? "");
		const exists = board.items.some((c) => c.id === id);
		if (!exists) return { content: [{ type: "text", text: `未找到卡片 ${id}` }] };
		board.items = board.items.filter((c) => c.id !== id);
		saveBoard(file, board);
		return { content: [{ type: "text", text: `已移除卡片 ${id}` }] };
	}

	return { content: [{ type: "text", text: `未知操作 ${op}(支持 add/list/get/move/finish/remove)` }] };
}