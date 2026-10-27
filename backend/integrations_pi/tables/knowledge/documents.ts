import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { purgeChunkVectors, purgeDocumentVectors } from "../../../services/vector-store.js";

export interface KnowledgeHit {
	chunkId: string;
	documentId: string;
	title: string;
	category: string | null;
	chunkIndex: number;
	content: string;
	snippet: string;
}

export function insertKnowledgeDocument(
	db: DatabaseSync,
	input: { tenantId: string; title: string; chunks: string[]; category?: string },
): { documentId: string; chunkIds: string[] } {
	const documentId = randomUUID();
	db.prepare("INSERT INTO knowledge_documents (id, tenant_id, title, content, category) VALUES (?,?,?,?,?)").run(
		documentId,
		input.tenantId,
		input.title,
		input.chunks.join("\n\n"),
		input.category ?? null,
	);
	const chunkIds: string[] = [];
	const insert = db.prepare("INSERT INTO knowledge_chunks (id, tenant_id, document_id, chunk_index, content) VALUES (?,?,?,?,?)");
	db.exec("BEGIN");
	try {
		input.chunks.forEach((content, index) => {
			const id = randomUUID();
			insert.run(id, input.tenantId, documentId, index, content);
			chunkIds.push(id);
		});
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
	return { documentId, chunkIds };
}

/** 删除文档及其分块(触发器自动清理 FTS 索引);返回是否删除。 */
export function deleteKnowledgeDocumentById(db: DatabaseSync, tenantId: string, documentId: string): boolean {
	const existing = db.prepare("SELECT id FROM knowledge_documents WHERE tenant_id = ? AND id = ?").get(tenantId, documentId);
	if (!existing) return false;
	db.exec("BEGIN");
	try {
		db.prepare("DELETE FROM knowledge_chunks WHERE tenant_id = ? AND document_id = ?").run(tenantId, documentId);
		db.prepare("DELETE FROM knowledge_documents WHERE tenant_id = ? AND id = ?").run(tenantId, documentId);
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
	// 向量随文档一起清理(本地同步 + Milvus 异步),否则语义通道会命中已删话术
	purgeDocumentVectors(db, tenantId, [documentId]);
	return true;
}

/**
 * 原地替换文档内容(保留 id 与标题):删掉全部分块(触发器自动清 FTS 索引),重写新分块,更新正文与分类。
 * 话术"覆盖更新"必须走这里 —— 之前的实现是删旧文档再按草稿标题新建,导致旧标题消失、
 * 同一场景在库里换了个名字存在,检索结果与覆盖率统计都会失真。
 */
export function replaceKnowledgeDocument(db: DatabaseSync, input: { tenantId: string; documentId: string; chunks: string[]; category?: string }): string[] {
	const doc = db.prepare("SELECT id FROM knowledge_documents WHERE tenant_id = ? AND id = ?").get(input.tenantId, input.documentId) as { id: string } | undefined;
	if (!doc) throw new Error(`文档不存在:${input.documentId}`);
	// 先采集旧分块 id:替换后它们不再存在,新分块用的是全新的 id
	const staleChunkIds = (db
		.prepare("SELECT id FROM knowledge_chunks WHERE tenant_id = ? AND document_id = ?")
		.all(input.tenantId, input.documentId) as Array<{ id: string }>).map((r) => r.id);
	db.exec("BEGIN");
	const chunkIds: string[] = [];
	try {
		db.prepare("DELETE FROM knowledge_chunks WHERE tenant_id = ? AND document_id = ?").run(input.tenantId, input.documentId);
		const content = input.chunks.join("\n\n");
		if (input.category === undefined) {
			db.prepare("UPDATE knowledge_documents SET content = ? WHERE tenant_id = ? AND id = ?").run(content, input.tenantId, input.documentId);
		} else {
			db.prepare("UPDATE knowledge_documents SET content = ?, category = ? WHERE tenant_id = ? AND id = ?").run(content, input.category || null, input.tenantId, input.documentId);
		}
		const insert = db.prepare("INSERT INTO knowledge_chunks (id, tenant_id, document_id, chunk_index, content) VALUES (?,?,?,?,?)");
		input.chunks.forEach((chunkText, index) => {
			const id = randomUUID();
			insert.run(id, input.tenantId, input.documentId, index, chunkText);
			chunkIds.push(id);
		});
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
	// 旧分块向量随替换一起清掉:按旧 chunkId 精确删除,既不留孤儿向量,也不会误删刚写入的新向量
	purgeChunkVectors(db, input.tenantId, staleChunkIds);
	return chunkIds;
}

/** 按标题删除文档(覆盖旧版本用)。 */
export function deleteKnowledgeDocumentByTitle(db: DatabaseSync, tenantId: string, title: string): boolean {
	const doc = findDocumentByTitle(db, tenantId, title);
	if (!doc) return false;
	return deleteKnowledgeDocumentById(db, tenantId, doc.id);
}

/** 按标题查文档 id(候选覆盖时定位旧文档用)。 */
export function findDocumentIdByTitle(db: DatabaseSync, tenantId: string, title: string): string | undefined {
	const doc = db.prepare("SELECT id FROM knowledge_documents WHERE tenant_id = ? AND title = ?").get(tenantId, title) as { id: string } | undefined;
	return doc?.id;
}

/** 读取文档完整内容(二次确认对比用)。 */
export function getKnowledgeDocumentContent(db: DatabaseSync, tenantId: string, documentId: string): string | undefined {
	const row = db.prepare("SELECT content FROM knowledge_documents WHERE tenant_id = ? AND id = ?").get(tenantId, documentId) as { content: string } | undefined;
	return row?.content;
}

/** 读取某文档的所有分块内容(相似度对比用)。 */
export function listKnowledgeDocumentChunks(db: DatabaseSync, tenantId: string, documentId: string): string[] {
	const rows = db.prepare("SELECT content FROM knowledge_chunks WHERE tenant_id = ? AND document_id = ? ORDER BY chunk_index").all(tenantId, documentId) as Array<{ content: string }>;
	return rows.map((r) => r.content);
}
export function findDocumentByTitle(db: DatabaseSync, tenantId: string, title: string) {
	return db.prepare("SELECT id FROM knowledge_documents WHERE tenant_id = ? AND title = ?").get(tenantId, title) as
		| { id: string }
		| undefined;
}

export function searchKnowledge(db: DatabaseSync, tenantId: string, query: string, limit: number): KnowledgeHit[] {
	const clean = query.trim().replace(/[，。！？、；：,.!?;:""''()（）\s]+/g, " ").trim();
	if (clean.length === 0) return [];

	const terms = clean.split(/\s+/).filter((term) => term.length > 0);
	const hits = new Map<string, KnowledgeHit>();
	const seenChunkIds = new Set<string>();

	const collect = (rows: KnowledgeHit[]) => {
		for (const row of rows) {
			if (!seenChunkIds.has(row.chunkId)) {
				seenChunkIds.add(row.chunkId);
				hits.set(row.chunkId, row);
			}
		}
	};

	for (const term of terms) {
		if (term.replace(/\s/g, "").length >= 3) {
			const ftsQuery = `"${term.replace(/"/g, "")}"`;
			const rows = db
				.prepare(
					`SELECT kc.id AS chunkId, kc.document_id AS documentId, kd.title, kd.category AS category, kc.chunk_index AS chunkIndex,
					        kc.content, snippet(knowledge_chunks_fts, 2, '【', '】', '…', 20) AS snippet
					 FROM knowledge_chunks_fts f
					 JOIN knowledge_chunks kc ON kc.id = f.chunk_id
					 JOIN knowledge_documents kd ON kd.id = kc.document_id
					 WHERE f.tenant_id = ? AND knowledge_chunks_fts MATCH ?
					 ORDER BY f.rank`,
				)
				.all(tenantId, ftsQuery) as unknown as KnowledgeHit[];
			collect(rows);
		} else {
			const rows = db
				.prepare(
					`SELECT kc.id AS chunkId, kc.document_id AS documentId, kd.title, kc.chunk_index AS chunkIndex,
					        kc.content, substr(kc.content, 1, 80) || '…' AS snippet
					 FROM knowledge_chunks kc
					 JOIN knowledge_documents kd ON kd.id = kc.document_id
					 WHERE kc.tenant_id = ? AND kc.content LIKE ?
					 LIMIT ?`,
				)
				.all(tenantId, `%${term}%`, limit) as unknown as KnowledgeHit[];
			collect(rows);
		}
	}

	if (hits.size > 0) return [...hits.values()].slice(0, limit);

	// 短词或 FTS 无命中:回退到 LIKE
	return db
		.prepare(
			`SELECT kc.id AS chunkId, kc.document_id AS documentId, kd.title, kd.category AS category, kc.chunk_index AS chunkIndex,
			        kc.content, substr(kc.content, 1, 80) || '…' AS snippet
			 FROM knowledge_chunks kc
			 JOIN knowledge_documents kd ON kd.id = kc.document_id
			 WHERE kc.tenant_id = ? AND kc.content LIKE ?
			 LIMIT ?`,
		)
		.all(tenantId, `%${clean}%`, limit) as unknown as KnowledgeHit[];
}
