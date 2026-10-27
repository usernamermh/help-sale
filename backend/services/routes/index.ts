import type { FastifyInstance } from "fastify";
import { requireTenant } from "../../integrations_pi/tables/crm/customers.js";
import { registerAgentRoutes } from "./agent/index.js";
import { registerAssistantRoutes } from "./assistant.js";
import { registerAutomationRoutes } from "./automation.js";
import { registerConversationRoutes } from "./conversations.js";
import { registerConsoleRoutes } from "./console.js";
import { registerKeywordRoutes } from "./keywords.js";
import { registerHealthRoutes } from "./health.js";
import { registerTaskRoutes } from "./tasks.js";
import { registerThreadRoutes } from "./threads.js";
import { registerKnowledgeRoutes } from "./knowledge.js";
import { registerNotificationRoutes } from "./notifications.js";
import { registerReflectionRoutes } from "./reflections.js";
import { registerSalesRoutes } from "./sales.js";
import { registerVectorRoutes } from "./vector.js";
import { registerWorkflowRoutes } from "./workflows.js";
import type { RouteDeps } from "./helpers.js";

export type { RouteDeps } from "./helpers.js";

/** 汇总注册各功能域路由:每个模块自带 register 函数(功能逻辑与路由同文件)。 */
export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
	// 每个请求先确保租户行存在(业务表都以 tenant_id 外键关联 tenants)
	app.addHook("preHandler", async (request) => {
		requireTenant(deps.db, request.tenantId, "API 租户");
	});

	registerAssistantRoutes(app, deps);
	registerKnowledgeRoutes(app, deps);
	registerVectorRoutes(app, deps);
	registerNotificationRoutes(app, deps);
	registerSalesRoutes(app, deps);
	registerAutomationRoutes(app, deps);
	registerAgentRoutes(app, deps);
	registerKeywordRoutes(app, deps);
	registerWorkflowRoutes(app, deps);
	registerReflectionRoutes(app, deps);
	registerConversationRoutes(app, deps);
	registerConsoleRoutes(app, deps);
	registerThreadRoutes(app, deps);
	registerTaskRoutes(app, deps);
	registerHealthRoutes(app);
}
