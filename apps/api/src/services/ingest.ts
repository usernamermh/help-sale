import type { DatabaseSync } from "node:sqlite";
import { config } from "../env.js";
import { findDocumentByTitle, insertKnowledgeDocument } from "../repositories/knowledge.js";
import { splitText } from "./chunker.js";

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

	const { documentId, chunkIds } = insertKnowledgeDocument(db, {
		tenantId: input.tenantId,
		title: input.title,
		category: input.category,
		chunks: splitText(input.content, { size: config.chunkerSize, overlap: config.chunkerOverlap }),
	});
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