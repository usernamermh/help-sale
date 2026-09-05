import { listTasks } from "../../apps/api/src/repositories/tasks.js";
import { config } from "../../apps/api/src/env.js";

interface ToolContext { db: any; tenantId: string; }

export function execute(ctx: ToolContext, params: any) {
	const rows = listTasks(ctx.db, { tenantId: ctx.tenantId, status: (params.status === "done" ? "done" : "pending") as "done" | "pending", limit: params.limit ?? config.agentListLimit });
	return { content: [{ type: "text", text: rows.length ? rows.map((t: any) => `${t.customerName ?? t.customerKey ?? "未知"} | ${t.action} | ${t.dueAt ?? "无期限"} | ${t.status}`).join("\n") : "暂无任务。" }], details: rows };
}