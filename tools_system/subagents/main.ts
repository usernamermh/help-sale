import { createKanbanTask, getKanbanCard, listKanbanCards, type KanbanCard } from "../../apps/api/src/services/kanban-store.js";

interface ToolContext { db: any; tenantId: string; }

function cardLine(c: KanbanCard): string {
	return `[${c.status}] ${c.id} ${c.title}: ${c.goal ?? ""}${c.result ? ` → ${c.result.slice(0, 60)}` : ""}${c.error ? ` ⚠ ${c.error.slice(0, 60)}` : ""}`;
}

export function execute(ctx: ToolContext, params: any) {
	const op = String(params?.op ?? "list");
	if (op === "create") {
		const title = String(params?.title ?? "").trim();
		const goal = String(params?.goal ?? "").trim();
		if (!title || !goal) return { content: [{ type: "text", text: "create 需要 title 与 goal。" }] };
		const tools = Array.isArray(params?.tools) ? params.tools.map((s: unknown) => String(s)) : undefined;
		const card = createKanbanTask({ tenantId: ctx.tenantId, title, goal, description: params?.description ? String(params.description) : undefined, tools });
		return { content: [{ type: "text", text: `子代理任务已登记 ${card.id}: ${title}(状态 ${card.status},将由消费者并行执行)` }], details: { id: card.id, title: card.title, status: card.status } };
	}
	if (op === "get") {
		const id = String(params?.taskId ?? params?.id ?? "").trim();
		const card = getKanbanCard(ctx.tenantId, id);
		if (!card) return { content: [{ type: "text", text: "未找到该子代理任务。" }] };
		const lines = [`[${card.status}] ${card.title}: ${card.goal ?? ""}`];
		if (card.result) lines.push(`结果: ${card.result}`);
		if (card.error) lines.push(`错误: ${card.error}`);
		return { content: [{ type: "text", text: lines.join("\n") }], details: card };
	}
	const filter = params?.statusFilter ? String(params.statusFilter) : undefined;
	const tasks = listKanbanCards(ctx.tenantId, filter);
	const text = tasks.length ? tasks.map(cardLine).join("\n") : "(子代理队列为空)";
	return { content: [{ type: "text", text: `子代理队列(${tasks.length}):\n${text}` }], details: { tasks } };
}