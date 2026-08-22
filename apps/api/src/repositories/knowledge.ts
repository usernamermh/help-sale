import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface KnowledgeHit {
	chunkId: string;
	documentId: string;
	title: string;
	chunkIndex: number;
	content: string;
	snippet: string;
}

export function insertKnowledgeDocument(
	db: DatabaseSync,
	input: { tenantId: string; title: string; chunks: string[] },
): { documentId: string; chunkIds: string[] } {
	const documentId = randomUUID();
	db.prepare("INSERT INTO knowledge_documents (id, tenant_id, title, content) VALUES (?,?,?,?)").run(
		documentId,
		input.tenantId,
		input.title,
		input.chunks.join("\n\n"),
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

export function findDocumentByTitle(db: DatabaseSync, tenantId: string, title: string) {
	return db.prepare("SELECT id FROM knowledge_documents WHERE tenant_id = ? AND title = ?").get(tenantId, title) as
		| { id: string }
		| undefined;
}

export function searchKnowledge(db: DatabaseSync, tenantId: string, query: string, limit = 5): KnowledgeHit[] {
	const clean = query.trim().replace(/[，。！？、；：,.!?;:""''()（）\s]+/g, " ").trim();
	if (clean.length === 0) return [];

	if (clean.replace(/\s/g, "").length >= 3) {
		const ftsQuery = `"${clean.replace(/"/g, "")}"`;
		const rows = db
			.prepare(
				`SELECT kc.id AS chunkId, kc.document_id AS documentId, kd.title, kc.chunk_index AS chunkIndex,
				        kc.content, snippet(knowledge_chunks_fts, 2, '【', '】', '…', 20) AS snippet
				 FROM knowledge_chunks_fts f
				 JOIN knowledge_chunks kc ON kc.id = f.chunk_id
				 JOIN knowledge_documents kd ON kd.id = kc.document_id
				 WHERE f.tenant_id = ? AND knowledge_chunks_fts MATCH ?
				 ORDER BY f.rank
				 LIMIT ?`,
			)
			.all(tenantId, ftsQuery, limit) as unknown as KnowledgeHit[];
		if (rows.length > 0) return rows;
	}

	// 短词或 FTS 无命中:回退到 LIKE
	return db
		.prepare(
			`SELECT kc.id AS chunkId, kc.document_id AS documentId, kd.title, kc.chunk_index AS chunkIndex,
			        kc.content, substr(kc.content, 1, 80) || '…' AS snippet
			 FROM knowledge_chunks kc
			 JOIN knowledge_documents kd ON kd.id = kc.document_id
			 WHERE kc.tenant_id = ? AND kc.content LIKE ?
			 LIMIT ?`,
		)
		.all(tenantId, `%${clean}%`, limit) as unknown as KnowledgeHit[];
}
