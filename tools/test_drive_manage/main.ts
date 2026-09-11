import { createTestDrive, listTestDrives, setTestDriveStatus } from "../../apps/api/src/repositories/test-drives.js";
import { setFunnelStage } from "../../apps/api/src/repositories/funnel.js";
import { resolveCustomerByKeyOrName } from "../../apps/api/src/services/customer-resolve.js";
import { scheduleTestDriveFollowups } from "../../apps/api/src/services/followup-rhythm.js";

interface ToolContext { db: any; tenantId: string; }

export function execute(ctx: ToolContext, params: any) {
	const op = params?.op ?? "list";
	if (op === "create") {
		const customerKey = String(params.customerKey ?? params.customerName ?? "").trim();
		if (!customerKey) return { content: [{ type: "text", text: "创建试驾需要 customerKey(或客户姓名)。" }] };
		const customer = resolveCustomerByKeyOrName(ctx.db, ctx.tenantId, customerKey);
		const td = createTestDrive(ctx.db, {
			tenantId: ctx.tenantId,
			customerId: customer.id,
			salesId: params.salesId,
			storeId: params.storeId,
			vehicleId: params.vehicleId,
			scheduledAt: params.scheduledAt,
		});
		setFunnelStage(ctx.db, ctx.tenantId, customer.key, "test_drive");
		return { content: [{ type: "text", text: `已登记试驾:${customer.name ?? customer.key} @ ${td.scheduled_at ?? "待定"}` }], details: td };
	}
	if (op === "complete") {
		const id = String(params.testDriveId ?? "").trim();
		if (!id) return { content: [{ type: "text", text: "需要 testDriveId。" }] };
		const done = setTestDriveStatus(ctx.db, ctx.tenantId, id, "completed", params.feedback, params.competitorCompared);
		if (!done) return { content: [{ type: "text", text: "未找到该试驾记录。" }] };
		if (done.customer_id) {
			const actions = scheduleTestDriveFollowups(ctx.db, ctx.tenantId, done.customer_id, done.scheduled_at ?? done.updated_at);
			return { content: [{ type: "text", text: `试驾已完成,自动生成 ${actions.length} 段回访任务。` }], details: { testDrive: done, followups: actions } };
		}
		return { content: [{ type: "text", text: "试驾已完成。" }], details: done };
	}
	if (op === "cancel") {
		const id = String(params.testDriveId ?? "").trim();
		const td = setTestDriveStatus(ctx.db, ctx.tenantId, id, "cancelled");
		return { content: [{ type: "text", text: td ? "试驾已取消。" : "未找到该试驾记录。" }], details: td };
	}
	const rows = listTestDrives(ctx.db, ctx.tenantId, { storeId: params.storeId, status: params.status, limit: params.limit ?? 50 });
	return {
		content: [{ type: "text", text: rows.length ? rows.map((t: any) => `${t.customer_name ?? t.customer_key ?? "未知"} | ${t.vehicle_name ?? "未指定车型"} | ${t.scheduled_at ?? "待定"} | ${t.status}`).join("\n") : "暂无试驾记录。" }],
		details: { testDrives: rows },
	};
}