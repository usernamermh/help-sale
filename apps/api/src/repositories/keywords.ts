import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type KeywordSource = "manual" | "extract_free" | "extract_strict";

export interface KeywordRecord {
	id: string;
	tenantId: string;
	keyword: string;
	category: string | null;
	source: KeywordSource;
	hitCount: number;
	createdAt: string;
	updatedAt: string;
}

export function listKeywords(db: DatabaseSync, tenantId: string, opts: { category?: string; limit?: number; keyword?: string } = {}): KeywordRecord[] {
	const clauses: string[] = ["tenant_id = ?"];
	const params: Array<string | number> = [tenantId];
	if (opts.category) { clauses.push("category = ?"); params.push(opts.category); }
	if (opts.keyword) { clauses.push("keyword LIKE ?"); params.push(`%${opts.keyword}%`); }
	params.push(opts.limit ?? 100);
	return (db
		.prepare(`SELECT * FROM keywords WHERE ${clauses.join(" AND ")} ORDER BY hit_count DESC, created_at DESC LIMIT ?`)
		.all(...params) as Record<string, unknown>[]).map(mapRow);
}

export function getKeyword(db: DatabaseSync, tenantId: string, id: string): KeywordRecord | undefined {
	const row = db.prepare("SELECT * FROM keywords WHERE tenant_id = ? AND id = ?").get(tenantId, id) as Record<string, unknown> | undefined;
	return row ? mapRow(row) : undefined;
}

export function upsertKeyword(db: DatabaseSync, tenantId: string, input: { keyword: string; category?: string; source?: KeywordSource; hitCount?: number }): KeywordRecord {
	const keyword = input.keyword.trim();
	const existing = db.prepare("SELECT * FROM keywords WHERE tenant_id = ? AND keyword = ?").get(tenantId, keyword) as Record<string, unknown> | undefined;
	if (existing) {
		const patch: string[] = [];
		const vals: Array<string | number> = [];
		if (input.category) { patch.push("category = ?"); vals.push(input.category); }
		if (input.hitCount != null) { patch.push("hit_count = hit_count + ?"); vals.push(input.hitCount); }
		patch.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
		vals.push(tenantId, String(existing.id));
		db.prepare(`UPDATE keywords SET ${patch.join(", ")} WHERE tenant_id = ? AND id = ?`).run(...vals);
		return getKeyword(db, tenantId, String(existing.id))!;
	}
	const id = randomUUID();
	const now = new Date().toISOString();
	db.prepare(
		"INSERT INTO keywords (id, tenant_id, keyword, category, source, hit_count, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
	).run(id, tenantId, keyword, input.category ?? null, input.source ?? "manual", input.hitCount ?? 0, now, now);
	return getKeyword(db, tenantId, id)!;
}

export function updateKeyword(db: DatabaseSync, tenantId: string, id: string, input: { keyword?: string; category?: string }): KeywordRecord | undefined {
	const existing = getKeyword(db, tenantId, id);
	if (!existing) return undefined;
	db.prepare(
		"UPDATE keywords SET keyword = ?, category = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND tenant_id = ?",
	).run(input.keyword?.trim() ?? existing.keyword, input.category ?? existing.category, id, tenantId);
	return getKeyword(db, tenantId, id);
}

export function deleteKeyword(db: DatabaseSync, tenantId: string, id: string): boolean {
	const r = db.prepare("DELETE FROM keywords WHERE tenant_id = ? AND id = ?").run(tenantId, id);
	return r.changes > 0;
}

/** 取前 N 个关键词(自由抽取时参考词库)。 */
export function listKeywordWords(db: DatabaseSync, tenantId: string, limit: number): string[] {
	return (db.prepare("SELECT keyword FROM keywords WHERE tenant_id = ? ORDER BY hit_count DESC, created_at DESC LIMIT ?").all(tenantId, limit) as Array<{ keyword: string }>).map((r) => r.keyword);
}

function mapRow(row: Record<string, unknown>): KeywordRecord {
	return {
		id: String(row.id),
		tenantId: String(row.tenant_id),
		keyword: String(row.keyword),
		category: row.category ? String(row.category) : null,
		source: String(row.source) as KeywordSource,
		hitCount: Number(row.hit_count ?? 0),
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}