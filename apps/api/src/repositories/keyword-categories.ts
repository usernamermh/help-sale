import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface CategoryRecord {
	id: string;
	tenantId: string;
	parentId: string | null;
	name: string;
	level: number;
	createdAt: string;
	updatedAt: string;
}

/** 分类树节点(含子级)。 */
export interface CategoryNode extends CategoryRecord {
	children: CategoryNode[];
}

export function listCategories(db: DatabaseSync, tenantId: string): CategoryRecord[] {
	return (db
		.prepare("SELECT * FROM keyword_categories WHERE tenant_id = ? ORDER BY level, created_at")
		.all(tenantId) as Record<string, unknown>[]).map(mapRow);
}

/** 构建三级分类树(0级虚拟根 → 一级 → 二级 → 三级)。 */
export function buildCategoryTree(db: DatabaseSync, tenantId: string): CategoryNode[] {
	const all = listCategories(db, tenantId);
	const byId = new Map<string, CategoryNode>();
	for (const c of all) byId.set(c.id, { ...c, children: [] });
	const roots: CategoryNode[] = [];
	for (const c of all) {
		const node = byId.get(c.id)!;
		if (c.parentId && byId.has(c.parentId)) byId.get(c.parentId)!.children.push(node);
		else roots.push(node);
	}
	return roots;
}

export function createCategory(db: DatabaseSync, tenantId: string, input: { name: string; parentId?: string; level?: number }): CategoryRecord {
	const name = input.name.trim();
	const parentId = input.parentId || null;
	const level = input.level ?? (parentId ? (getCategory(db, tenantId, parentId)?.level ?? 1) + 1 : 1);
	const id = randomUUID();
	const now = new Date().toISOString();
	db.prepare(
		"INSERT INTO keyword_categories (id, tenant_id, parent_id, name, level, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
	).run(id, tenantId, parentId, name, level, now, now);
	return getCategory(db, tenantId, id)!;
}

export function getCategory(db: DatabaseSync, tenantId: string, id: string): CategoryRecord | undefined {
	const row = db.prepare("SELECT * FROM keyword_categories WHERE tenant_id = ? AND id = ?").get(tenantId, id) as Record<string, unknown> | undefined;
	return row ? mapRow(row) : undefined;
}

export function renameCategory(db: DatabaseSync, tenantId: string, id: string, name: string): CategoryRecord | undefined {
	const c = getCategory(db, tenantId, id);
	if (!c) return undefined;
	db.prepare("UPDATE keyword_categories SET name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND tenant_id = ?").run(name.trim(), id, tenantId);
	return getCategory(db, tenantId, id);
}

/** 删除分类:级联删子级(外键 ON DELETE CASCADE);同时清理关键词上的该分类路径。 */
export function deleteCategory(db: DatabaseSync, tenantId: string, id: string): boolean {
	const c = getCategory(db, tenantId, id);
	if (!c) return false;
	db.exec("BEGIN");
	try {
		// 收集该分类及其子级 id
		const all = listCategories(db, tenantId);
		const toDelete = new Set<string>();
		const collect = (catId: string) => {
			toDelete.add(catId);
			for (const child of all.filter((x) => x.parentId === catId)) collect(child.id);
		};
		collect(id);
		// 先删分类(级联删子级),再清理关键词上对应路径字段
		for (const catId of toDelete) {
			db.prepare("DELETE FROM keyword_categories WHERE tenant_id = ? AND id = ?").run(tenantId, catId);
		}
		// 清理关键词:被删分类(含其级联删除的子级)对应的路径字段全部置空
		const deletedNames = new Set(all.filter((x) => toDelete.has(x.id)).map((x) => x.name));
		const path = categoryPath(all, id);
		const namePlaceholders = [...deletedNames].map(() => "?").join(",");
		if (deletedNames.size === 0) {
			// 空集合兜底
		} else if (c.level === 1 && path.l1) {
			// 顺序:先清 l3(依赖 l1+l2),再清 l2(依赖 l1),最后清 l1
			db.prepare(`UPDATE keywords SET category_l3 = NULL WHERE tenant_id = ? AND category_l1 = ? AND category_l2 IN (${namePlaceholders})`).run(tenantId, path.l1, ...deletedNames);
			db.prepare(`UPDATE keywords SET category_l2 = NULL WHERE tenant_id = ? AND category_l1 = ? AND category_l2 IN (${namePlaceholders})`).run(tenantId, path.l1, ...deletedNames);
			db.prepare(`UPDATE keywords SET category_l1 = NULL WHERE tenant_id = ? AND category_l1 IN (${namePlaceholders})`).run(tenantId, ...deletedNames);
		} else if (c.level === 2 && path.l1 && path.l2) {
			// 顺序:先清 l3(依赖 l1+l2),再清 l2
			db.prepare(`UPDATE keywords SET category_l3 = NULL WHERE tenant_id = ? AND category_l1 = ? AND category_l2 = ? AND category_l3 IN (${namePlaceholders})`).run(tenantId, path.l1, path.l2, ...deletedNames);
			db.prepare(`UPDATE keywords SET category_l2 = NULL WHERE tenant_id = ? AND category_l1 = ? AND category_l2 IN (${namePlaceholders})`).run(tenantId, path.l1, ...deletedNames);
		} else if (c.level >= 3 && path.l1 && path.l2 && path.l3) {
			db.prepare(`UPDATE keywords SET category_l3 = NULL WHERE tenant_id = ? AND category_l1 = ? AND category_l2 = ? AND category_l3 IN (${namePlaceholders})`).run(tenantId, path.l1, path.l2, path.l3, ...deletedNames);
		}
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
	return true;
}

/** 计算某分类的 一级/二级/三级 路径名称。 */
function categoryPath(all: CategoryRecord[], id: string): { l1?: string; l2?: string; l3?: string } {
	const byId = new Map(all.map((c) => [c.id, c]));
	const path: string[] = [];
	let cur = byId.get(id);
	while (cur) { path.unshift(cur.name); cur = cur.parentId ? byId.get(cur.parentId) : undefined; }
	return { l1: path[0], l2: path[1], l3: path[2] };
}

function mapRow(row: Record<string, unknown>): CategoryRecord {
	return {
		id: String(row.id),
		tenantId: String(row.tenant_id),
		parentId: row.parent_id ? String(row.parent_id) : null,
		name: String(row.name),
		level: Number(row.level ?? 1),
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}