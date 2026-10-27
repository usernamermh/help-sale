import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface NotificationLogRecord {
	id: string;
	tenantId: string;
	channel: string;
	title: string;
	contentJson: string;
	status: string;
	createdAt: string;
}

export function createNotificationLog(
	db: DatabaseSync,
	input: { tenantId: string; channel?: string; title: string; contentJson: string; status?: string },
): NotificationLogRecord {
	const id = randomUUID();
	db.prepare(
		"INSERT INTO notification_logs (id, tenant_id, channel, title, content_json, status) VALUES (?,?,?,?,?,?)",
	).run(id, input.tenantId, input.channel ?? "webhook", input.title, input.contentJson, input.status ?? "sent");
	return db.prepare("SELECT * FROM notification_logs WHERE id = ?").get(id) as unknown as NotificationLogRecord;
}

export function listNotificationLogs(db: DatabaseSync, tenantId: string, limit = 20): NotificationLogRecord[] {
	const rows = db
		.prepare("SELECT * FROM notification_logs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?")
		.all(tenantId, limit) as Record<string, unknown>[];
	return rows.map((row) => ({
		id: String(row.id),
		tenantId: String(row.tenant_id),
		channel: String(row.channel),
		title: String(row.title),
		contentJson: String(row.content_json),
		status: String(row.status),
		createdAt: String(row.created_at),
	}));
}