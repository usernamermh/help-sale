import { createTask, listTasks, setTaskStatus } from "../../apps/api/src/repositories/tasks.js";
import { resolveCustomerByKeyOrName } from "../../apps/api/src/services/customer-resolve.js";
import { config } from "../../apps/api/src/env.js";

interface ToolContext { db: any; tenantId: string; }

export function execute(ctx: ToolContext, params: any) {
	const op = params?.op ?? "list";
	if (op === "create") {
		const customerKey = String(params.customerKey ?? params.customerName ?? "").trim();
		const action = String(params.action ?? "").trim();
		if (!customerKey || !action) return { content: [{ type: "text", text: "创建任务需要 customerKey(或客户姓名)与 action。" }] };
		if (params.dueAt != null && !Number.isFinite(Date.parse(String(params.dueAt)))) {
			return { content: [{ type: "text", text: `dueAt 不是有效日期:${params.dueAt}` }] };
		}
		const row = resolveCustomerByKeyOrName(ctx.db, ctx.tenantId, customerKey);
		const task = createTask(ctx.db, { tenantId: ctx.tenantId, customerId: row.id, action, dueAt: params.dueAt ? String(params.dueAt) : undefined });
		return { content: [{ type: "text", text: `已创建任务:${task.action}` }], details: task };
	}
	if (op === "complete") {
		const task = setTaskStatus(ctx.db, ctx.tenantId, String(params.taskId ?? ""), "done");
		return { content: [{ type: "text", text: task ? `已完成任务:${task.action}` : "未找到该任务。" }], details: task };
	}
	const rows = listTasks(ctx.db, { tenantId: ctx.tenantId, status: params.status === "done" ? "done" : "pending", limit: params.limit ?? config.agentListLimit });
	return {
		content: [{ type: "text", text: rows.length ? rows.map((t: any) => `${t.customerName ?? t.customerKey ?? "未知"} | ${t.action} | ${t.dueAt ?? "无期限"} | ${t.status}`).join("\n") : "暂无任务。" }],
		details: { tasks: rows },
	};
}