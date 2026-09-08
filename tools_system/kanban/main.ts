import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface ToolContext { db: any; tenantId: string; }

interface Card { id: string; title: string; description?: string; status: string; createdAt: string; updatedAt: string; }

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// 每次执行时取路径,便于测试用 KANBAN_FILE 重定向
const boardFile = () => process.env.KANBAN_FILE ?? path.join(repoRoot, "data", "kanban.json");

function loadBoard(): { items: Card[]; nextId: number } {
	if (!existsSync(boardFile())) return { items: [], nextId: 1 };
	try { return JSON.parse(readFileSync(boardFile(), "utf8")) as { items: Card[]; nextId: number }; } catch { return { items: [], nextId: 1 }; }
}
function saveBoard(board: { items: Card[]; nextId: number }): void {
	mkdirSync(path.dirname(boardFile()), { recursive: true });
	writeFileSync(boardFile(), JSON.stringify(board, null, 2), "utf8");
}

export function execute(_ctx: ToolContext, params: any) {
	const op = String(params?.op ?? "list");
	const board = loadBoard();
	const now = new Date().toISOString();
	if (op === "add") {
		const title = String(params?.title ?? "").trim();
		if (!title) return { content: [{ type: "text", text: "add 需要 title。" }] };
		const id = `K${board.nextId++}`;
		board.items.push({ id, title, description: params?.description ? String(params.description) : undefined, status: params?.status ?? "todo", createdAt: now, updatedAt: now });
		saveBoard(board);
		return { content: [{ type: "text", text: `已添加卡片 ${id}: ${title}` }], details: { id } };
	}
	if (op === "list") {
		const filter = params?.statusFilter ? String(params.statusFilter) : undefined;
		const items = board.items.filter((c) => !filter || c.status === filter);
		const text = items.length ? items.map((c) => `[${c.status}] ${c.id} ${c.title}${c.description ? ` - ${c.description}` : ""}`).join("\n") : "(看板为空)";
		return { content: [{ type: "text", text: `看板(${items.length} 张卡片):\n${text}` }], details: { items } };
	}
	if (op === "move" || op === "get" || op === "remove") {
		const id = String(params?.id ?? "");
		const card = board.items.find((c) => c.id === id);
		if (!card) return { content: [{ type: "text", text: `未找到卡片 ${id}` }] };
		if (op === "get") return { content: [{ type: "text", text: JSON.stringify(card) }], details: { card } };
		if (op === "move") { card.status = params?.status ?? "inprogress"; card.updatedAt = now; saveBoard(board); return { content: [{ type: "text", text: `卡片 ${id} -> ${card.status}` }], details: { card } }; }
		board.items = board.items.filter((c) => c.id !== id);
		saveBoard(board);
		return { content: [{ type: "text", text: `已移除卡片 ${id}` }] };
	}
	return { content: [{ type: "text", text: `未知操作 ${op}(支持 add/list/move/get/remove)` }] };
}