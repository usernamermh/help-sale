// notifications 域路由(由 v1 routes/list_for_view.ts 拆分而来)
import type { FastifyInstance } from "fastify";
import { listNotificationLogs } from "../../integrations_pi/tables/automation/notifications.js";
import { notifyOverdue } from "../notifications.js";
import { config } from "../../env.js";
import { type RouteDeps } from "./helpers.js";

export function registerNotificationRoutes(app: FastifyInstance, deps: RouteDeps): void {
app.post("/api/v1/notifications/trigger", async (request, reply) => {
		const result = await notifyOverdue(deps.db, {
			tenantId: request.tenantId,
			reminders: deps.reminders,
			webhookUrl: config.notificationEnabled ? config.notificationWebhookUrl : undefined,
		});
		return reply.send(result);
	});

app.get("/api/v1/notifications", async (request) => {
		return { logs: listNotificationLogs(deps.db, request.tenantId) };
	});
}
