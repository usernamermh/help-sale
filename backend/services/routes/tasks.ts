// tasks.ts(由 v1 routes/new_task.ts 迁移)
import type { FastifyInstance } from "fastify";
import { createTask, getTask, listTasks, setTaskStatus } from "../../integrations_pi/tables/sales/tasks.js";
import { config } from "../../env.js";
import type { RouteDeps } from "./helpers.js";

export function registerTaskRoutes(app: FastifyInstance, deps: RouteDeps): void {
	app.get<{ Querystring: { status?: string; due_before?: string; limit?: string } }>("/api/v1/tasks", async (request) => {
		const status = request.query.status as import("../../integrations_pi/tables/sales/tasks.js").TaskStatus | undefined;
		const tasks = listTasks(deps.db, {
			tenantId: request.tenantId,
			status,
			dueBefore: request.query.due_before,
			limit: Number(request.query.limit ?? 50),
		});
		return { tasks };
	});

	app.patch<{ Params: { id: string } }>("/api/v1/tasks/:id/done", async (request, reply) => {
		const task = setTaskStatus(deps.db, request.tenantId, request.params.id, "done");
		if (!task) return reply.code(404).send({ error: "task_not_found", message: "任务不存在" });
		void deps.reminders.remove(request.tenantId, task.id);
		return { task };
	});

	app.get("/api/v1/reminders/overdue", async (request) => {
		const entries = await deps.reminders.due(Date.now(), config.remindersTakeLimit);
		const ids = entries.filter((entry) => entry.tenantId === request.tenantId).map((entry) => entry.taskId);
		const overdue = ids
			.map((id) => getTask(deps.db, request.tenantId, id))
			.filter((task): task is NonNullable<typeof task> => !!task && task.status === "pending");
		return { overdue, generatedAt: new Date().toISOString() };
	});
}
