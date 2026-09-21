import { createKanbanTask, getKanbanCard, listKanbanCards, updateKanbanCard, removeKanbanByThread, type KanbanCard } from "../../apps/api/src/services/kanban-store.js";

interface ToolContext { db: any; tenantId: string; }

function cardText(c: KanbanCard): string {
	const parts = [`[${c.status}] ${c.id} ${c.title}`];
	if (c.description) parts.push(`- ${c.description}`);
	if (c.goal) parts.push(`目标:${c.goal}`);
	if (c.result) parts.push(`结果:${c.result.length > 80 ? c.result.slice(0, 80) + "…" : c.result}`);
	if (c.error) parts.push(`错误:${c.error}`);
	return parts.join(" ");
}

export function execute(ctx: ToolContext, params: any) {
	const db = ctx.db;
	const op = String(params?.op ?? "list");
	const tenantId = ctx.tenantId || "t_default";

	if (op === "add") {
		const title = String(params?.title ?? "").trim();
		if (!title) return { content: [{ type: "text", text: "add 需要 title。" }] };
		const card = createKanbanTask(db, {
			tenantId,
			threadId: String(params?.threadId ?? "default"),
			title,
			goal: params?.goal ? String(params.goal) : "",
			description: params?.description ? String(params.description) : undefined,
			tools: Array.isArray(params?.tools) ? params.tools.map((s: unknown) => String(s)) : undefined,
			status: params?.status ? String(params.status) : "pending",
		});
		return { content: [{ type: "text", text: `已添加卡片 ${card.id}: ${title}` }], details: { id: card.id, card } };
	}

	if (op === "list") {
		const filter = params?.statusFilter ? String(params.statusFilter) : undefined;
		const threadId = params?.threadId ? String(params.threadId) : undefined;
		const items = listKanbanCards(db, tenantId, { status: filter, threadId });
		const text = items.length ? items.map(cardText).join("\n") : "(看板为空)";
		return { content: [{ type: "text", text: `看板(${items.length} 张卡片):\n${text}` }], details: { items } };
	}

	if (op === "get") {
		const id = String(params?.id ?? "");
		const card = getKanbanCard(db, tenantId, id);
		if (!card) return { content: [{ type: "text", text: `未找到卡片 ${id}` }] };
		return { content: [{ type: "text", text: JSON.stringify(card) }], details: { card } };
	}

	if (op === "move") {
		const id = String(params?.id ?? "");
		const card = updateKanbanCard(db, tenantId, id, { status: params?.status ? String(params.status) : "inprogress" });
		if (!card) return { content: [{ type: "text", text: `未找到卡片 ${id}` }] };
		return { content: [{ type: "text", text: `卡片 ${id} -> ${card.status}` }], details: { card } };
	}

	if (op === "finish") {
		const id = String(params?.id ?? "");
		const ok = params?.ok === false || String(params?.ok ?? "true") === "false" ? false : true;
		const card = updateKanbanCard(db, tenantId, id, {
			status: ok ? "done" : "error",
			result: ok && params?.result != null ? String(params.result) : undefined,
			error: !ok && params?.error != null ? String(params.error) : undefined,
		});
		if (!card) return { content: [{ type: "text", text: `未找到卡片 ${id}` }] };
		return { content: [{ type: "text", text: `卡片 ${id} 已${ok ? "完成" : "标记错误"}` }], details: { card } };
	}

	if (op === "remove") {
		const id = String(params?.id ?? "");
		const card = getKanbanCard(db, tenantId, id);
		if (!card) return { content: [{ type: "text", text: `未找到卡片 ${id}` }] };
		removeKanbanByThread(db, tenantId, card.threadId);
		return { content: [{ type: "text", text: `已移除卡片 ${id}` }] };
	}

	return { content: [{ type: "text", text: `未知操作 ${op}(支持 add/list/get/move/finish/remove)` }] };
}