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
	const parent = parentId ? getCategory(db, tenantId, parentId) : undefined;
	if (parentId && !parent) throw new Error("父级分类不存在");
	if (parent && parent.level >= 3) throw new Error("最多支持三级分类");
	if (listCategories(db, tenantId).some((x) => x.parentId === parentId && x.name === name)) {
		throw new Error(`同一父级下已存在同名分类「${name}」`);
	}
	const level = input.level ?? (parent ? parent.level + 1 : 1);
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

export function renameCategory(
	db: DatabaseSync,
	tenantId: string,
	id: string,
	input: { name?: string; parentId?: string | null },
): CategoryRecord | undefined {
	const c = getCategory(db, tenantId, id);
	if (!c) return undefined;
	const newName = input.name?.trim() || c.name;
	const newParentId = input.parentId === undefined ? c.parentId : (input.parentId || null);
	if (newParentId === id) throw new Error("不能将分类移动到自身或子级下");
	if (newParentId) {
		const parent = getCategory(db, tenantId, newParentId);
		if (!parent) return undefined;
		if (parent.level >= 3) throw new Error("最多支持三级分类");
	}
	const all = listCategories(db, tenantId);
	if (all.some((x) => x.id !== id && x.parentId === newParentId && x.name === newName)) {
		throw new Error(`同一父级下已存在同名分类「${newName}」`);
	}
	const newLevel = newParentId ? getCategory(db, tenantId, newParentId)!.level + 1 : 1;
	db.exec("BEGIN");
	try {
		db.prepare(
			"UPDATE keyword_categories SET name = ?, parent_id = ?, level = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND tenant_id = ?",
		).run(newName, newParentId, newLevel, id, tenantId);
		recalcDescendantLevels(db, tenantId, id, newLevel);
		if (newName !== c.name || (newParentId ?? null) !== (c.parentId ?? null)) {
			const oldRoot = categoryPathArray(all, id);
			const parent = newParentId ? getCategory(db, tenantId, newParentId)! : undefined;
			const newRoot = parent ? [...categoryPathArray(all, parent.id), newName] : [newName];
			const affected = collectSubtree(all, id);
			syncKeywordPaths(db, tenantId, oldRoot, newRoot, affected, all);
		}
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
	return getCategory(db, tenantId, id);
}

/** 返回分类从根到自身的名称路径数组。 */
function categoryPathArray(all: CategoryRecord[], id: string): string[] {
	const byId = new Map(all.map((c) => [c.id, c]));
	const parts: string[] = [];
	let cur = byId.get(id);
	while (cur) {
		parts.unshift(cur.name);
		cur = cur.parentId ? byId.get(cur.parentId) : undefined;
	}
	return parts;
}

/** 收集分类自身及全部子级 id(深度优先,自身在前)。 */
function collectSubtree(all: CategoryRecord[], id: string): string[] {
	const out: string[] = [];
	const walk = (cid: string) => {
		out.push(cid);
		for (const x of all) if (x.parentId === cid) walk(x.id);
	};
	walk(id);
	return out;
}

/** 重算某分类下所有子级的 level。 */
function recalcDescendantLevels(db: DatabaseSync, tenantId: string, rootId: string, rootLevel: number) {
	const all = listCategories(db, tenantId);
	const byParent = new Map<string, string[]>();
	for (const c of all) if (c.parentId) {
		const arr = byParent.get(c.parentId) ?? [];
		arr.push(c.id);
		byParent.set(c.parentId, arr);
	}
	const queue: Array<{ id: string; level: number }> = [{ id: rootId, level: rootLevel }];
	while (queue.length) {
		const cur = queue.shift()!;
		for (const childId of byParent.get(cur.id) ?? []) {
			db.prepare("UPDATE keyword_categories SET level = ? WHERE id = ? AND tenant_id = ?").run(cur.level + 1, childId, tenantId);
			queue.push({ id: childId, level: cur.level + 1 });
		}
	}
}

/** 同步关键词上的分类路径字段(名称),先深后浅避免中间态误匹配。 */
function syncKeywordPaths(db: DatabaseSync, tenantId: string, oldRoot: string[], newRoot: string[], affectedIds: string[], all: CategoryRecord[]) {
	const rootId = affectedIds[0];
	const jobs: Array<{ oldP: string[]; newP: string[] }> = [];
	for (const id of affectedIds) {
		const rel: string[] = [];
		const byId = new Map(all.map((c) => [c.id, c]));
		let cur = byId.get(id);
		while (cur && cur.id !== rootId) {
			rel.unshift(cur.name);
			cur = cur.parentId ? byId.get(cur.parentId) : undefined;
		}
		jobs.push({ oldP: [...oldRoot, ...rel], newP: [...newRoot, ...rel] });
	}
	jobs.sort((a, b) => b.oldP.length - a.oldP.length);
	for (const { oldP, newP } of jobs) {
		if (oldP.length === 1) {
			db.prepare("UPDATE keywords SET category_l1 = ? WHERE tenant_id = ? AND category_l1 = ?").run(newP[0], tenantId, oldP[0]);
		} else if (oldP.length === 2) {
			db.prepare("UPDATE keywords SET category_l1 = ?, category_l2 = ? WHERE tenant_id = ? AND category_l1 = ? AND category_l2 = ?").run(newP[0], newP[1], tenantId, oldP[0], oldP[1]);
		} else if (oldP.length >= 3) {
			db.prepare("UPDATE keywords SET category_l1 = ?, category_l2 = ?, category_l3 = ? WHERE tenant_id = ? AND category_l1 = ? AND category_l2 = ? AND category_l3 = ?").run(newP[0], newP[1], newP[2], tenantId, oldP[0], oldP[1], oldP[2]);
		}
	}
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