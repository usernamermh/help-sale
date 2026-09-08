import type { DatabaseSync } from "node:sqlite";
import { config } from "../env.js";
import { getTask } from "../repositories/tasks.js";
import { createNotificationLog, listNotificationLogs } from "../repositories/notification-logs.js";
import type { ReminderQueue } from "../integrations/reminder-queue.js";

export interface NotifyResult {
	overdueCount: number;
	newlyNotified: string[];
	skipped: string[];
	pushed: boolean;
	status: "sent" | "failed" | "none";
	reason?: string;
}


/**
 * 扫描到期提醒并推送通知(webhook),记录发送日志,基于最近日志去重避免重复推送。
 * webhookUrl 为空时只写日志不推送(pushed=false,status='none' 由调用方忽略)。
 */
export async function notifyOverdue(
	db: DatabaseSync,
	input: {
		tenantId: string;
		reminders: ReminderQueue;
		webhookUrl?: string;
		now?: Date;
		fetchImpl?: typeof fetch;
	},
): Promise<NotifyResult> {
	const now = input.now ?? new Date();
	const ids = await input.reminders.due(now.getTime(), 100);
	const tasks = ids
		.map((id) => getTask(db, input.tenantId, id))
		.filter((t): t is NonNullable<typeof t> => !!t && t.status === "pending");

	// 已通知去重:扫最近日志的内容(task_ids)
	const notified = new Set<string>();
	for (const log of listNotificationLogs(db, input.tenantId, config.notificationScanLimit)) {
		try {
			const parsed = JSON.parse(log.contentJson) as { task_ids?: string[] };
			for (const taskId of parsed.task_ids ?? []) notified.add(taskId);
		} catch {
			// 忽略解析失败
		}
	}

	const fresh = tasks.filter((t) => !notified.has(t.id));
	const skipped = tasks.filter((t) => notified.has(t.id)).map((t) => t.id);

	if (fresh.length === 0) {
		return { overdueCount: tasks.length, newlyNotified: [], skipped, pushed: false, status: "none", reason: "无新到期任务" };
	}

	const payload = {
		type: "overdue_reminder",
		tenantId: input.tenantId,
		generatedAt: now.toISOString(),
		taskIds: fresh.map((t) => t.id),
		tasks: fresh.map((t) => ({
			id: t.id,
			customer: t.customerName ?? t.customerKey ?? "未知客户",
			action: t.action,
			dueAt: t.dueAt,
		})),
	};

	let status: "sent" | "failed" = "sent";
	let pushed = false;
	let reason: string | undefined;
	if (input.webhookUrl) {
		const fetchImpl = input.fetchImpl ?? globalThis.fetch;
		try {
			const res = await fetchImpl(input.webhookUrl, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			pushed = true;
		} catch (error) {
			status = "failed";
			reason = error instanceof Error ? error.message : String(error);
		}
	}

	createNotificationLog(db, {
		tenantId: input.tenantId,
		channel: input.webhookUrl ? "webhook" : "internal",
		title: `到期提醒 ${fresh.length} 条`,
		contentJson: JSON.stringify({ task_ids: fresh.map((t) => t.id), ...payload }),
		status,
	});

	return { overdueCount: tasks.length, newlyNotified: fresh.map((t) => t.id), skipped, pushed, status, reason };
}