import type { DatabaseSync } from "node:sqlite";
import { findDocumentByTitle, insertKnowledgeDocument } from "../repositories/knowledge.js";
import { splitText } from "./chunker.js";

export interface IngestResult {
	skipped: boolean;
	documentId?: string;
	chunkCount?: number;
}

export function ingestDocument(
	db: DatabaseSync,
	input: { tenantId: string; title: string; content: string },
): IngestResult {
	if (findDocumentByTitle(db, input.tenantId, input.title)) {
		return { skipped: true };
	}
	const chunks = splitText(input.content);
	const { documentId, chunkIds } = insertKnowledgeDocument(db, {
		tenantId: input.tenantId,
		title: input.title,
		chunks,
	});
	return { skipped: false, documentId, chunkCount: chunkIds.length };
}