/** 知识入库管线:分块 → 落库 → 入向量队列 */
import type { DatabaseSync } from "node:sqlite";
import { config } from "../env.js";
import { findDocumentByTitle, insertKnowledgeDocument } from "../integrations_pi/tables/knowledge/documents.js";
import { splitText } from "./chunker.js";
import { queueDocumentVectors } from "./vector-store.js";

export interface IngestResult {
	skipped: boolean;
	documentId?: string;
	chunkCount?: number;
}

export function ingestDocument(
	db: DatabaseSync,
	input: { tenantId: string; title: string; content: string; category?: string },
): IngestResult {
	if (findDocumentByTitle(db, input.tenantId, input.title)) {
		return { skipped: true };
	}

	const chunks = splitText(input.content, { size: config.chunkerSize, overlap: config.chunkerOverlap });
	const { documentId, chunkIds } = insertKnowledgeDocument(db, {
		tenantId: input.tenantId,
		title: input.title,
		category: input.category,
		chunks,
	});
	// 入库即排队做向量索引(异步,不阻塞返回):让 knowledge_search / playbook_check 可走语义通道
	queueDocumentVectors(db, { tenantId: input.tenantId, documentId, category: input.category ?? "", chunks });
	return { skipped: false, documentId, chunkCount: chunkIds.length };
}

/** 批量导入多条知识点(同一分类),逐条幂等。 */
export function ingestEntries(
	db: DatabaseSync,
	input: { tenantId: string; category?: string; entries: Array<{ title: string; content: string }> },
): Array<IngestResult & { title: string }> {
	return input.entries.map((entry) => ({
		title: entry.title,
		...ingestDocument(db, { tenantId: input.tenantId, title: entry.title, content: entry.content, category: input.category }),
	}));
}