import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface AgentEventRecord {
	id: string;
	tenantId: string;
	conversationId: string;
	seq: number;
	eventType: string;
	toolName: string | null;
	payloadJson: string | null;
	createdAt: string;
}

export async function appendAgentEvent(
	db: DatabaseSync,
	input: { tenantId: string; conversationId: string; eventType: string; toolName?: string; payloadJson?: string },
): Promise<void> {
	const row = db
		.prepare(
			"SELECT COALESCE(MAX(seq), 0) AS seq FROM agent_events WHERE tenant_id = ? AND conversation_id = ?",
		)
		.get(input.tenantId, input.conversationId) as { seq: number };
	const id = randomUUID();
	db.prepare(
		"INSERT INTO agent_events (id, tenant_id, conversation_id, seq, event_type, tool_name, payload_json) VALUES (?,?,?,?,?,?,?)",
	).run(id, input.tenantId, input.conversationId, row.seq + 1, input.eventType, input.toolName ?? null, input.payloadJson ?? null);
}

export function listAgentEvents(db: DatabaseSync, tenantId: string, conversationId: string): AgentEventRecord[] {
	const rows = db
		.prepare("SELECT * FROM agent_events WHERE tenant_id = ? AND conversation_id = ? ORDER BY seq ASC")
		.all(tenantId, conversationId) as Record<string, unknown>[];
	return rows.map((row) => ({
		id: String(row.id),
		tenantId: String(row.tenant_id),
		conversationId: String(row.conversation_id),
		seq: Number(row.seq),
		eventType: String(row.event_type),
		toolName: row.tool_name ? String(row.tool_name) : null,
		payloadJson: row.payload_json ? String(row.payload_json) : null,
		createdAt: String(row.created_at),
	}));
}