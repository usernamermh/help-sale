import { setTaskStatus } from "../../apps/api/src/repositories/tasks.js";

interface ToolContext { db: any; tenantId: string; }

export function execute(ctx: ToolContext, params: any) {
	const task = setTaskStatus(ctx.db, ctx.tenantId, params.taskId, "done");
	return { content: [{ type: "text", text: task ? `已完成任务:${task.action}` : "未找到该任务。" }], details: task };
}