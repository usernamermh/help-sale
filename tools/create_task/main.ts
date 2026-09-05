import { getCustomer, upsertCustomer } from "../../apps/api/src/repositories/customers.js";
import { createTask } from "../../apps/api/src/repositories/tasks.js";

interface ToolContext { db: any; tenantId: string; }

export function execute(ctx: ToolContext, params: any) {
	let row = getCustomer(ctx.db, ctx.tenantId, params.customerKey);
	if (!row) row = upsertCustomer(ctx.db, { tenantId: ctx.tenantId, key: params.customerKey });
	const task = createTask(ctx.db, { tenantId: ctx.tenantId, customerId: row.id, action: params.action, dueAt: params.dueAt });
	return { content: [{ type: "text", text: `已创建任务:${task.action}` }], details: task };
}