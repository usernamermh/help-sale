import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface AgentEventRecord {
	id: string;
	tenantId: string;
	conversationId: string;
	threadId: string | null;
	seq: number;
	eventType: string;
	toolName: string | null;
	payloadJson: string | null;
	createdAt: string;
}

export async function appendAgentEvent(
	db: DatabaseSync,
	input: { tenantId: string; conversationId: string; threadId?: string; eventType: string; toolName?: string; payloadJson?: string },
): Promise<void> {
	const row = db
		.prepare(
			"SELECT COALESCE(MAX(seq), 0) AS seq FROM agent_events WHERE tenant_id = ? AND conversation_id = ?",
		)
		.get(input.tenantId, input.conversationId) as { seq: number };
	const id = randomUUID();
	db.prepare(
		"INSERT INTO agent_events (id, tenant_id, conversation_id, thread_id, seq, event_type, tool_name, payload_json) VALUES (?,?,?,?,?,?,?,?)",
	).run(id, input.tenantId, input.conversationId, input.threadId ?? null, row.seq + 1, input.eventType, input.toolName ?? null, input.payloadJson ?? null);
}

export function listAgentEvents(db: DatabaseSync, tenantId: string, conversationId: string): AgentEventRecord[] {
	const rows = db
		.prepare("SELECT * FROM agent_events WHERE tenant_id = ? AND conversation_id = ? ORDER BY seq ASC")
		.all(tenantId, conversationId) as Record<string, unknown>[];
	return rows.map((row) => ({
		id: String(row.id),
		tenantId: String(row.tenant_id),
		conversationId: String(row.conversation_id),
		threadId: row.thread_id ? String(row.thread_id) : null,
		seq: Number(row.seq),
		eventType: String(row.event_type),
		toolName: row.tool_name ? String(row.tool_name) : null,
		payloadJson: row.payload_json ? String(row.payload_json) : null,
		createdAt: String(row.created_at),
	}));
}

/**
 * 批量写事件轨迹:一次取基准 seq,再按块拼多值 INSERT。
 * 单个事件写库要 2 次 SQL,而每次 SQL 往返在网络库上要几十毫秒 —— 一轮几十上百个事件时,
 * 逐条写就是几秒到十几秒,所以这里必须批量化。
 */
export async function appendAgentEvents(
	db: DatabaseSync,
	input: {
		tenantId: string;
		conversationId: string;
		threadId?: string;
		events: Array<{ eventType: string; toolName?: string; payloadJson?: string }>;
	},
): Promise<number> {
	if (input.events.length === 0) return 0;
	const head = db
		.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM agent_events WHERE tenant_id = ? AND conversation_id = ?")
		.get(input.tenantId, input.conversationId) as { seq: number };
	let seq = Number(head.seq);
	const CHUNK = 200; // 每块 200 行 × 8 参数,远离驱动与 max_allowed_packet 限制
	for (let offset = 0; offset < input.events.length; offset += CHUNK) {
		const slice = input.events.slice(offset, offset + CHUNK);
		const placeholders = slice.map(() => "(?,?,?,?,?,?,?,?)").join(",");
		const values: Array<string | number | null> = [];
		for (const item of slice) {
			seq += 1;
			values.push(randomUUID(), input.tenantId, input.conversationId, input.threadId ?? null, seq, item.eventType, item.toolName ?? null, item.payloadJson ?? null);
		}
		db.prepare(
			`INSERT INTO agent_events (id, tenant_id, conversation_id, thread_id, seq, event_type, tool_name, payload_json) VALUES ${placeholders}`,
		).run(...values);
	}
	return input.events.length;
}