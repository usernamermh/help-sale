import type { DatabaseSync } from "node:sqlite";

export interface ConversationMetaRow {
	id: string;
	tenantId: string;
	customerId: string | null;
	customerKey: string | null;
	customerName: string | null;
	storeName: string | null;
	salesName: string;
	salesId: string | null;
	salesPhone: string | null;
	storeId: string | null;
	followupAdvice: string | null;
	channel: string;
	messageCount: number;
	createdAt: string;
	updatedAt: string;
}

export function upsertConversation(
	db: DatabaseSync,
	input: {
		id: string;
		tenantId: string;
		customerId?: string | null;
		salesName?: string;
		salesId?: string | null;
		salesPhone?: string | null;
		storeId?: string | null;
		followupAdvice?: string | null;
		channel?: string;
		messageCount?: number;
	},
): ConversationMetaRow {
	const existing = getConversation(db, input.tenantId, input.id);
	const salesName = input.salesName ?? existing?.salesName ?? "默认销售";
	const messageCount = input.messageCount ?? existing?.messageCount ?? 0;
	if (existing) {
		db.prepare(
			`UPDATE conversations
			 SET customer_id = ?, sales_name = ?, sales_id = ?, sales_phone = ?, store_id = ?, followup_advice = ?, channel = ?, message_count = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
			 WHERE tenant_id = ? AND id = ?`,
		).run(
			input.customerId ?? existing.customerId,
			salesName,
			input.salesId ?? existing.salesId ?? null,
			input.salesPhone ?? existing.salesPhone ?? null,
			input.storeId ?? existing.storeId ?? null,
			input.followupAdvice ?? existing.followupAdvice ?? null,
			input.channel ?? existing.channel,
			messageCount,
			input.tenantId,
			input.id,
		);
		return getConversation(db, input.tenantId, input.id)!;
	}
	db.prepare(
		"INSERT INTO conversations (id, tenant_id, customer_id, sales_name, sales_id, sales_phone, store_id, followup_advice, channel, message_count) VALUES (?,?,?,?,?,?,?,?,?,?)",
	).run(
		input.id,
		input.tenantId,
		input.customerId ?? null,
		salesName,
		input.salesId ?? null,
		input.salesPhone ?? null,
		input.storeId ?? null,
		input.followupAdvice ?? null,
		input.channel ?? "chat",
		messageCount,
	);
	return getConversation(db, input.tenantId, input.id)!;
}

export function getConversation(db: DatabaseSync, tenantId: string, id: string): ConversationMetaRow | undefined {
	const row = db
		.prepare(
			`SELECT c.*, cu.key AS customer_key, cu.name AS customer_name, st.name AS store_name
			 FROM conversations c
			 LEFT JOIN customers cu ON cu.id = c.customer_id
			 LEFT JOIN stores st ON st.id = c.store_id
			 WHERE c.tenant_id = ? AND c.id = ?`,
		)
		.get(tenantId, id) as Record<string, unknown> | undefined;
	return row ? mapRow(row) : undefined;
}

export function listConversations(db: DatabaseSync, tenantId: string, limit: number): ConversationMetaRow[] {
	const rows = db
		.prepare(
			`SELECT c.*, cu.key AS customer_key, cu.name AS customer_name, st.name AS store_name
			 FROM conversations c
			 LEFT JOIN customers cu ON cu.id = c.customer_id
			 LEFT JOIN stores st ON st.id = c.store_id
			 WHERE c.tenant_id = ?
			 ORDER BY c.updated_at DESC LIMIT ?`,
		)
		.all(tenantId, limit) as Record<string, unknown>[];
	return rows.map(mapRow);
}

function mapRow(row: Record<string, unknown>): ConversationMetaRow {
	return {
		id: String(row.id),
		tenantId: String(row.tenant_id),
		customerId: row.customer_id ? String(row.customer_id) : null,
		customerKey: row.customer_key ? String(row.customer_key) : null,
		customerName: row.customer_name != null ? String(row.customer_name) : null,
		storeName: row.store_name != null ? String(row.store_name) : null,
		salesName: String(row.sales_name),
		salesId: row.sales_id ? String(row.sales_id) : null,
		salesPhone: row.sales_phone ? String(row.sales_phone) : null,
		storeId: row.store_id ? String(row.store_id) : null,
		followupAdvice: row.followup_advice ? String(row.followup_advice) : null,
		channel: String(row.channel),
		messageCount: Number(row.message_count),
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}