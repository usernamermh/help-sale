import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type KeywordSource = "manual" | "extract_free" | "extract_strict";

export interface KeywordRecord {
	id: string;
	tenantId: string;
	keyword: string;
	category: string | null;
	categoryL1: string | null;
	categoryL2: string | null;
	categoryL3: string | null;
	source: KeywordSource;
	hitCount: number;
	createdAt: string;
	updatedAt: string;
}

export interface KeywordQuery {
	categoryL1?: string;
	categoryL2?: string;
	categoryL3?: string;
	keyword?: string;
	page?: number;
	pageSize?: number;
}

export interface KeywordPage {
	items: KeywordRecord[];
	total: number;
	page: number;
	pageSize: number;
	totalPages: number;
}

/** 分类目录查询:返回各级去重列表(联动筛选用)。 */
export function listKeywordCategories(db: DatabaseSync, tenantId: string): { l1: string[]; l2: Record<string, string[]>; l3: Record<string, string[]> } {
	const rows = db.prepare(
		"SELECT DISTINCT category_l1, category_l2, category_l3 FROM keywords WHERE tenant_id = ? AND (category_l1 IS NOT NULL AND category_l1 <> '')",
	).all(tenantId) as Array<{ category_l1: string | null; category_l2: string | null; category_l3: string | null }>;
	const l1 = new Set<string>();
	const l2: Record<string, Set<string>> = {};
	const l3: Record<string, Set<string>> = {};
	for (const r of rows) {
		if (r.category_l1) {
			l1.add(r.category_l1);
			(l2[r.category_l1] ??= new Set<string>());
			if (r.category_l2) l2[r.category_l1].add(r.category_l2);
		}
		if (r.category_l1 && r.category_l2) {
			const key = `${r.category_l1}/${r.category_l2}`;
			(l3[key] ??= new Set<string>());
			if (r.category_l3) l3[key].add(r.category_l3);
		}
	}
	return {
		l1: [...l1].sort(),
		l2: Object.fromEntries(Object.entries(l2).map(([k, v]) => [k, [...v].sort()])),
		l3: Object.fromEntries(Object.entries(l3).map(([k, v]) => [k, [...v].sort()])),
	};
}

export function listKeywords(db: DatabaseSync, tenantId: string, query: KeywordQuery = {}): KeywordPage {
	const clauses: string[] = ["tenant_id = ?"];
	const params: Array<string | number> = [tenantId];
	if (query.categoryL1) { clauses.push("category_l1 = ?"); params.push(query.categoryL1); }
	if (query.categoryL2) { clauses.push("category_l2 = ?"); params.push(query.categoryL2); }
	if (query.categoryL3) { clauses.push("category_l3 = ?"); params.push(query.categoryL3); }
	if (query.keyword) { clauses.push("keyword LIKE ?"); params.push(`%${query.keyword}%`); }
	const where = clauses.join(" AND ");
	const total = (db.prepare(`SELECT COUNT(*) AS n FROM keywords WHERE ${where}`).get(...params) as { n: number }).n;
	const page = Math.max(1, query.page ?? 1);
	const pageSize = Math.min(Math.max(1, query.pageSize ?? 20), 100);
	const rows = db
		.prepare(`SELECT * FROM keywords WHERE ${where} ORDER BY updated_at DESC, created_at DESC LIMIT ? OFFSET ?`)
		.all(...params, pageSize, (page - 1) * pageSize) as Record<string, unknown>[];
	return {
		items: rows.map(mapRow),
		total,
		page,
		pageSize,
		totalPages: Math.max(1, Math.ceil(total / pageSize)),
	};
}

export function getKeyword(db: DatabaseSync, tenantId: string, id: string): KeywordRecord | undefined {
	const row = db.prepare("SELECT * FROM keywords WHERE tenant_id = ? AND id = ?").get(tenantId, id) as Record<string, unknown> | undefined;
	return row ? mapRow(row) : undefined;
}

export function upsertKeyword(db: DatabaseSync, tenantId: string, input: { keyword: string; category?: string; categoryL1?: string; categoryL2?: string; categoryL3?: string; source?: KeywordSource; hitCount?: number }): KeywordRecord {
	const keyword = input.keyword.trim();
	const existing = db.prepare("SELECT * FROM keywords WHERE tenant_id = ? AND keyword = ?").get(tenantId, keyword) as Record<string, unknown> | undefined;
	if (existing) {
		const patch: string[] = [];
		const vals: Array<string | number> = [];
		if (input.category) { patch.push("category = ?"); vals.push(input.category); }
		if (input.categoryL1) { patch.push("category_l1 = ?"); vals.push(input.categoryL1); }
		if (input.categoryL2) { patch.push("category_l2 = ?"); vals.push(input.categoryL2); }
		if (input.categoryL3) { patch.push("category_l3 = ?"); vals.push(input.categoryL3); }
		if (input.hitCount != null) { patch.push("hit_count = hit_count + ?"); vals.push(input.hitCount); }
		patch.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
		vals.push(tenantId, String(existing.id));
		db.prepare(`UPDATE keywords SET ${patch.join(", ")} WHERE tenant_id = ? AND id = ?`).run(...vals);
		return getKeyword(db, tenantId, String(existing.id))!;
	}
	const id = randomUUID();
	const now = new Date().toISOString();
	db.prepare(
		"INSERT INTO keywords (id, tenant_id, keyword, category, category_l1, category_l2, category_l3, source, hit_count, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
	).run(id, tenantId, keyword, input.category ?? null, input.categoryL1 ?? null, input.categoryL2 ?? null, input.categoryL3 ?? null, input.source ?? "manual", input.hitCount ?? 0, now, now);
	return getKeyword(db, tenantId, id)!;
}

export function updateKeyword(db: DatabaseSync, tenantId: string, id: string, input: { keyword?: string; category?: string; categoryL1?: string; categoryL2?: string; categoryL3?: string }): KeywordRecord | undefined {
	const existing = getKeyword(db, tenantId, id);
	if (!existing) return undefined;
	db.prepare(
		"UPDATE keywords SET keyword = ?, category = ?, category_l1 = ?, category_l2 = ?, category_l3 = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND tenant_id = ?",
	).run(input.keyword?.trim() ?? existing.keyword, input.category ?? existing.category, input.categoryL1 ?? existing.categoryL1, input.categoryL2 ?? existing.categoryL2, input.categoryL3 ?? existing.categoryL3, id, tenantId);
	return getKeyword(db, tenantId, id);
}

export function deleteKeyword(db: DatabaseSync, tenantId: string, id: string): boolean {
	const r = db.prepare("DELETE FROM keywords WHERE tenant_id = ? AND id = ?").run(tenantId, id);
	return r.changes > 0;
}

/** 取前 N 个关键词(自由抽取时参考词库)。 */
export function listKeywordWords(db: DatabaseSync, tenantId: string, limit: number): string[] {
	return (db.prepare("SELECT keyword FROM keywords WHERE tenant_id = ? ORDER BY updated_at DESC, created_at DESC LIMIT ?").all(tenantId, limit) as Array<{ keyword: string }>).map((r) => r.keyword);
}

function mapRow(row: Record<string, unknown>): KeywordRecord {
	return {
		id: String(row.id),
		tenantId: String(row.tenant_id),
		keyword: String(row.keyword),
		category: row.category ? String(row.category) : null,
		categoryL1: row.category_l1 ? String(row.category_l1) : null,
		categoryL2: row.category_l2 ? String(row.category_l2) : null,
		categoryL3: row.category_l3 ? String(row.category_l3) : null,
		source: String(row.source) as KeywordSource,
		hitCount: Number(row.hit_count ?? 0),
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}