import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ingestDocument } from "../services/ingest.js";
import { deleteKnowledgeDocumentByTitle, getKnowledgeDocumentContent, insertKnowledgeDocument, listKnowledgeDocumentChunks, searchKnowledge } from "./knowledge.js";
import { cosineSim } from "../../../../tools_system/_shared/text-vec.js";
import { embedTextsSafe } from "../../../../tools_system/_shared/bge-embed.js";
import { config } from "../env.js";
import { splitText } from "../services/chunker.js";

export type CandidateStatus = "pending" | "approved" | "rejected";
export type SuggestAction = "add" | "update" | "skip";

export interface CandidateRecord {
	id: string;
	tenantId: string;
	analysisId: string;
	intent: string;
	draftTitle: string;
	draftContent: string;
	status: CandidateStatus;
	suggestAction?: SuggestAction;
	matchedTitle?: string;
	similarityScore?: number;
	oldTitle?: string;
	oldContent?: string;
	reviewNote?: string;
	createdAt: string;
	approvedAt: string | null;
	documentId?: string;
}

export function createCandidate(
	db: DatabaseSync,
	input: { tenantId: string; analysisId: string; intent: string; draftTitle: string; draftContent: string },
): CandidateRecord {
	const id = randomUUID();
	db.prepare(
		"INSERT INTO knowledge_candidates (id, tenant_id, analysis_id, intent, draft_title, draft_content) VALUES (?,?,?,?,?,?)",
	).run(id, input.tenantId, input.analysisId, input.intent, input.draftTitle, input.draftContent);
	return getCandidate(db, input.tenantId, id)!;
}

export function getCandidate(db: DatabaseSync, tenantId: string, id: string): CandidateRecord | undefined {
	const row = db
		.prepare("SELECT * FROM knowledge_candidates WHERE tenant_id = ? AND id = ?")
		.get(tenantId, id) as Record<string, unknown> | undefined;
	return row ? mapRow(row) : undefined;
}

export function listCandidates(db: DatabaseSync, tenantId: string, status: CandidateStatus | undefined, limit: number): CandidateRecord[] {
	const rows = status
		? (db
				.prepare(
					"SELECT * FROM knowledge_candidates WHERE tenant_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?",
				)
				.all(tenantId, status, limit) as Record<string, unknown>[])
		: (db
				.prepare("SELECT * FROM knowledge_candidates WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?")
				.all(tenantId, limit) as Record<string, unknown>[]);
	return rows.map(mapRow);
}

/** 二次确认:检索全库 + 语义相似度,判断新增/覆盖/跳过建议。 */
export async function reviewCandidate(db: DatabaseSync, tenantId: string, candidateId: string): Promise<CandidateRecord | undefined> {
	const c = getCandidate(db, tenantId, candidateId);
	if (!c) return undefined;

	// 1) 检索相关文档(标题+内容关键词,取前 5)
	const query = `${c.draftTitle} ${c.draftContent.slice(0, 200)}`;
	const hits = searchKnowledge(db, tenantId, query, 5);

	// 2) 语义相似度:候选内容 vs 命中文档分块,取最高分
	let best: { title: string; score: number; content: string } | undefined;
	if (hits.length > 0) {
		const targets: Array<{ title: string; content: string }> = [];
		for (const h of hits) {
			const chunks = listKnowledgeDocumentChunks(db, tenantId, h.documentId);
			for (const chunk of chunks) targets.push({ title: h.title, content: chunk });
		}
		const qVecs = await embedTextsSafe([c.draftContent]);
		const tVecs = await embedTextsSafe(targets.map((t) => t.content));
		let bestScore = 0;
		for (let i = 0; i < targets.length; i++) {
			const score = cosineSim(qVecs[0], tVecs[i]);
			if (score > bestScore) { bestScore = score; best = { title: targets[i].title, score, content: targets[i].content }; }
		}
	}

	// 3) 建议规则:无命中/低相似→新增;高相似但内容不同→覆盖;极高相似→跳过
	let action: SuggestAction = "add";
	let note = "知识库未命中相似内容,建议新增。";
	let oldTitle: string | undefined;
	let oldContent: string | undefined;
	if (best) {
		if (best.score >= 0.9) {
			action = "skip";
			note = `与「${best.title}」相似度 ${best.score.toFixed(2)},内容基本一致,建议跳过。`;
		} else if (best.score >= 0.45) {
			action = "update";
			oldTitle = best.title;
			oldContent = best.content;
			note = `与「${best.title}」相似度 ${best.score.toFixed(2)},内容有差异,建议覆盖更新。`;
		} else {
			note = `与「${best.title}」相似度 ${best.score.toFixed(2)},相关性低,建议新增。`;
		}
	}

	db.prepare(
		"UPDATE knowledge_candidates SET suggest_action = ?, matched_title = ?, similarity_score = ?, old_title = ?, old_content = ?, review_note = ? WHERE id = ?",
	).run(action, best?.title ?? null, best?.score ?? null, oldTitle ?? null, oldContent ?? null, note, candidateId);
	return getCandidate(db, tenantId, candidateId);
}

/** 确认入库:按建议动作执行(新增/覆盖/跳过),候选标记 approved。 */
export async function approveCandidate(db: DatabaseSync, tenantId: string, candidateId: string): Promise<CandidateRecord | undefined> {
	const existing = getCandidate(db, tenantId, candidateId);
	if (!existing) return undefined;
	if (existing.status === "approved") return existing;

	// 未二次确认的先确认
	const c = existing.suggestAction ? existing : (await reviewCandidate(db, tenantId, candidateId)) ?? existing;

	let documentId: string | undefined;
	if (c.suggestAction === "update" && c.oldTitle) {
		// 覆盖:删除旧标题文档,再写入新内容
		const oldDoc = deleteKnowledgeDocumentByTitle(db, tenantId, c.oldTitle);
		documentId = insertKnowledgeDocument(db, { tenantId, title: c.draftTitle, chunks: splitText(c.draftContent, { size: config.chunkerSize, overlap: config.chunkerOverlap }), category: c.intent || undefined }).documentId;
		c.reviewNote = `${oldDoc ? "已覆盖" : "未找到旧文档,按新增处理"}:${c.reviewNote ?? ""}`;
	} else if (c.suggestAction !== "skip") {
		const result = ingestDocument(db, { tenantId, title: c.draftTitle, content: c.draftContent, category: c.intent || undefined });
		documentId = result.documentId;
	} // skip:不落库

	db.prepare(
		"UPDATE knowledge_candidates SET status = 'approved', approved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), review_note = ? WHERE id = ?",
	).run(c.reviewNote ?? null, candidateId);

	const record = getCandidate(db, tenantId, candidateId)!;
	return { ...record, documentId };
}

export function rejectCandidate(db: DatabaseSync, tenantId: string, candidateId: string): CandidateRecord | undefined {
	const existing = getCandidate(db, tenantId, candidateId);
	if (!existing) return undefined;
	db.prepare("UPDATE knowledge_candidates SET status = 'rejected' WHERE id = ?").run(candidateId);
	return getCandidate(db, tenantId, candidateId);
}

function mapRow(row: Record<string, unknown>): CandidateRecord {
	return {
		id: String(row.id),
		tenantId: String(row.tenant_id),
		analysisId: String(row.analysis_id),
		intent: String(row.intent),
		draftTitle: String(row.draft_title),
		draftContent: String(row.draft_content),
		status: String(row.status) as CandidateStatus,
		suggestAction: row.suggest_action ? (String(row.suggest_action) as SuggestAction) : undefined,
		matchedTitle: row.matched_title ? String(row.matched_title) : undefined,
		similarityScore: row.similarity_score != null ? Number(row.similarity_score) : undefined,
		oldTitle: row.old_title ? String(row.old_title) : undefined,
		oldContent: row.old_content ? String(row.old_content) : undefined,
		reviewNote: row.review_note ? String(row.review_note) : undefined,
		createdAt: String(row.created_at),
		approvedAt: row.approved_at ? String(row.approved_at) : null,
	};
}