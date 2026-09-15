import { createSubTask, getSubTask, listSubTasks } from "../../apps/api/src/services/subagent-queue.js";

interface ToolContext { db: any; tenantId: string; }

export function execute(_ctx: ToolContext, params: any) {
	const op = String(params?.op ?? "list");
	if (op === "create") {
		const title = String(params?.title ?? "").trim();
		const goal = String(params?.goal ?? "").trim();
		if (!title || !goal) return { content: [{ type: "text", text: "create 需要 title 与 goal。" }] };
		const tools = Array.isArray(params?.tools) ? params.tools.map((s: unknown) => String(s)) : undefined;
		const task = createSubTask({ tenantId: _ctx.tenantId, title, goal, input: params?.input, tools });
		return { content: [{ type: "text", text: `子代理任务已登记 ${task.id}: ${title}` }], details: { id: task.id, title: task.title, status: task.status } };
	}
	if (op === "get") {
		const id = String(params?.taskId ?? "").trim();
		const task = getSubTask(id);
		if (!task) return { content: [{ type: "text", text: "未找到该子代理任务。" }] };
		const lines = [`[${task.status}] ${task.title}: ${task.goal}`];
		if (task.result) lines.push(`结果: ${task.result}`);
		if (task.error) lines.push(`错误: ${task.error}`);
		return { content: [{ type: "text", text: lines.join("\n") }], details: task };
	}
	const filter = params?.statusFilter ? String(params.statusFilter) : undefined;
	const tasks = listSubTasks(filter as never);
	const text = tasks.length ? tasks.map((t) => `[${t.status}] ${t.id.slice(0, 8)} ${t.title}: ${t.goal}${t.result ? ` → ${t.result.slice(0, 60)}` : ""}`).join("\n") : "(子代理队列为空)";
	return { content: [{ type: "text", text: `子代理队列(${tasks.length}):\n${text}` }], details: { tasks } };
}