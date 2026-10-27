import { createHash, randomUUID } from "node:crypto";
import { stableStringify } from "../../../services/stable-json.js";
import type { DatabaseSync } from "node:sqlite";

export interface ConversationMessageRow {
	id: string; tenant_id: string; conversation_id: string; seq: number;
	speaker_role: string; speaker_name: string | null; content: string; spoken_at: string | null; created_at: string;
}
export interface ConversationMessageInput {
	seq: number; speakerRole: string; speakerName?: string; content: string; spokenAt?: string;
}

export function appendConversationMessages(db: DatabaseSync, tenantId: string, conversationId: string, messages: ConversationMessageInput[]): void {
	const ins = db.prepare("INSERT INTO conversation_messages (id, tenant_id, conversation_id, seq, speaker_role, speaker_name, content, spoken_at) VALUES (?,?,?,?,?,?,?,?)");
	for (const m of messages) {
		ins.run(randomUUID(), tenantId, conversationId, m.seq, m.speakerRole, m.speakerName ?? null, m.content, m.spokenAt ?? null);
	}
}
export function listConversationMessages(db: DatabaseSync, tenantId: string, conversationId: string): ConversationMessageRow[] {
	return db.prepare("SELECT * FROM conversation_messages WHERE tenant_id = ? AND conversation_id = ? ORDER BY seq").all(tenantId, conversationId) as unknown as ConversationMessageRow[];
}

export interface ToolCacheRow {
	id: string; tenant_id: string; tool_name: string; cache_key: string; result_json: string; created_at: string; last_used_at: string | null;
}
export function getToolCache(db: DatabaseSync, tenantId: string, toolName: string, cacheKey: string): string | undefined {
	const row = db.prepare("SELECT result_json FROM tool_call_cache WHERE tenant_id = ? AND tool_name = ? AND cache_key = ?").get(tenantId, toolName, cacheKey) as { result_json: string } | undefined;
	if (row) db.prepare("UPDATE tool_call_cache SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE tenant_id = ? AND tool_name = ? AND cache_key = ?").run(tenantId, toolName, cacheKey);
	return row?.result_json;
}
export function putToolCache(db: DatabaseSync, tenantId: string, toolName: string, cacheKey: string, resultJson: string): void {
	db.prepare(
		`INSERT INTO tool_call_cache (id, tenant_id, tool_name, cache_key, result_json)
		 VALUES (?,?,?,?,?)
		 ON CONFLICT(tenant_id, tool_name, cache_key) DO UPDATE SET result_json = excluded.result_json, last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
	).run(randomUUID(), tenantId, toolName, cacheKey, resultJson);
}

export interface ReplaceConversationMessageInput {
	speakerRole: string;
	speakerName?: string;
	content: string;
	spokenAt?: string;
}

/** 全量替换某会话的原文消息(幂等:先删后插),未提供时间时按序生成近似时间。 */
export function replaceConversationMessages(db: DatabaseSync, tenantId: string, conversationId: string, messages: ReplaceConversationMessageInput[]): number {
	db.prepare("DELETE FROM conversation_messages WHERE tenant_id = ? AND conversation_id = ?").run(tenantId, conversationId);
	const base = Date.now();
	const items: ConversationMessageInput[] = messages.map((m, i) => ({
		seq: i + 1,
		speakerRole: m.speakerRole,
		speakerName: m.speakerName,
		content: m.content,
		spokenAt: m.spokenAt ?? new Date(base - (messages.length - i) * 30_000).toISOString(),
	}));
	appendConversationMessages(db, tenantId, conversationId, items);
	return items.length;
}

/** 工具调用缓存的稳定键:忽略参数键序。 */
export function toolCacheKey(input: unknown): string {
	return createHash("sha256").update(stableStringify(input)).digest("hex");
}

/**
 * 知识内容版本号:用于失效"结果会随知识库变化"的只读工具缓存。
 * 取 knowledge_documents / knowledge_chunks 的条数 + 最新写入时间拼合:
 * 任何入库、覆盖、删除都会改变它,因此不需要维护显式的缓存失效任务。
 */
export function knowledgeVersion(db: DatabaseSync, tenantId: string): string {
	const row = db
		.prepare(
			`SELECT (SELECT COUNT(*) FROM knowledge_documents WHERE tenant_id = ?) AS docs,
			        (SELECT COUNT(*) FROM knowledge_chunks WHERE tenant_id = ?) AS chunks,
			        (SELECT MAX(created_at) FROM knowledge_documents WHERE tenant_id = ?) AS latest`,
		)
		.get(tenantId, tenantId, tenantId) as { docs: number; chunks: number; latest: string | null };
	return `k${row.docs ?? 0}-${row.chunks ?? 0}-${row.latest ?? "0"}`;
}

/** 结果依赖知识库内容的只读工具:缓存键需带知识版本号,新话术入库后立即可见。 */
const KNOWLEDGE_SCOPED_TOOLS = new Set(["knowledge_search", "playbook_check"]);

/** 带缓存的工具调用:命中直接返回缓存结果,未命中执行 compute 并落库。 */
export function withToolCache<T>(db: DatabaseSync, tenantId: string, toolName: string, input: unknown, compute: () => T): T {
	const version = KNOWLEDGE_SCOPED_TOOLS.has(toolName) ? knowledgeVersion(db, tenantId) : "";
	const key = version ? `${version}|${toolCacheKey(input)}` : toolCacheKey(input);
	const cached = getToolCache(db, tenantId, toolName, key);
	if (cached !== undefined) return JSON.parse(cached) as T;
	const result = compute();
	putToolCache(db, tenantId, toolName, key, JSON.stringify(result));
	return result;
}