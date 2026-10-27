import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface KeywordHitRecord {
	id: string;
	tenantId: string;
	keywordId: string;
	conversationId: string | null;
	conversationDate: string | null;
	salesName: string | null;
	customerName: string | null;
	createdAt: string;
}

export interface HitCountResult {
	counted: boolean; // false = 该会话已统计过,未重复计数(去重)
	hitId?: string;
}

/** 记录一次关键词命中明细(关键词 x 会话 唯一去重):同会话重复命中不重复计数。 */
export function recordKeywordHit(
	db: DatabaseSync,
	tenantId: string,
	input: { keywordId: string; conversationId?: string; conversationDate?: string; salesName?: string; customerName?: string },
): HitCountResult {
	if (!input.conversationId) {
		// 无会话标识(旧调用方式):直接计数,不做会话去重
		db.prepare("UPDATE keywords SET hit_count = hit_count + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND tenant_id = ?").run(input.keywordId, tenantId);
		return { counted: true };
	}
	const existing = db
		.prepare("SELECT id FROM keyword_hits WHERE tenant_id = ? AND keyword_id = ? AND conversation_id = ?")
		.get(tenantId, input.keywordId, input.conversationId);
	if (existing) return { counted: false };
	const id = randomUUID();
	db.prepare(
		"INSERT INTO keyword_hits (id, tenant_id, keyword_id, conversation_id, conversation_date, sales_name, customer_name) VALUES (?,?,?,?,?,?,?)",
	).run(id, tenantId, input.keywordId, input.conversationId, input.conversationDate ?? null, input.salesName ?? null, input.customerName ?? null);
	db.prepare("UPDATE keywords SET hit_count = hit_count + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND tenant_id = ?").run(input.keywordId, tenantId);
	return { counted: true, hitId: id };
}

/** 某关键词的命中明细列表。 */
export function listKeywordHits(db: DatabaseSync, tenantId: string, keywordId: string, limit = 100): KeywordHitRecord[] {
	const rows = db
		.prepare("SELECT * FROM keyword_hits WHERE tenant_id = ? AND keyword_id = ? ORDER BY created_at DESC LIMIT ?")
		.all(tenantId, keywordId, limit) as Array<Record<string, unknown>>;
	return rows.map((r) => ({
		id: String(r.id),
		tenantId: String(r.tenant_id),
		keywordId: String(r.keyword_id),
		conversationId: r.conversation_id ? String(r.conversation_id) : null,
		conversationDate: r.conversation_date ? String(r.conversation_date) : null,
		salesName: r.sales_name ? String(r.sales_name) : null,
		customerName: r.customer_name ? String(r.customer_name) : null,
		createdAt: String(r.created_at),
	}));
}

/** 标记对话已挖掘(避免重复挖掘)。 */
export function markConversationMined(db: DatabaseSync, tenantId: string, conversationId: string): void {
	db.prepare("UPDATE conversations SET keyword_mined_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND tenant_id = ?").run(conversationId, tenantId);
}

/** 判断对话是否已挖掘过关键词。 */
export function isConversationMined(db: DatabaseSync, tenantId: string, conversationId: string): boolean {
	const row = db.prepare("SELECT keyword_mined_at FROM conversations WHERE id = ? AND tenant_id = ?").get(conversationId, tenantId) as { keyword_mined_at: string | null } | undefined;
	return Boolean(row && row.keyword_mined_at);
}
