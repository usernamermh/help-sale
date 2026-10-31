/** 向量存取与语义检索(本地 + Milvus 降级) */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { config } from "../env.js";
import { embedTextsSafe } from "../../tools_system/_shared/bge-embed.js";
import { cosineSim } from "../../tools_system/_shared/text-vec.js";
import { deleteVectorsByChunkIds, deleteVectorsByDocumentIds, milvusEnabled, searchVectors, upsertVectors, type MilvusSearchHit } from "./milvus.js";

/**
 * 向量检索统一入口(语义通道)。
 * 写入:知识分块向量同时落
 *   1) 本地 knowledge_embeddings(SQLite,权威副本 + Milvus 不可用时的兜底检索源 + 重建数据源)
 *   2) Milvus(配置开启时;失败只告警,不影响主链路)
 * 读取:Milvus 可用则走 Milvus,否则本地余弦扫描;两者都返回 {chunkId, score} 供上层回表取正文。
 */
export interface VectorHit {
	chunkId: string;
	score: number;
}

/** chunkId(TEXT uuid) → Milvus Int64 主键:FNV-1a 64bit 折叠到 53 位安全整数。 */
export function chunkPkOf(chunkId: string): number {
	let h1 = 0x811c9dc5;
	let h2 = 0x01000193;
	for (let i = 0; i < chunkId.length; i++) {
		const c = chunkId.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
		h2 = (h2 * 31 + c) >>> 0;
	}
	// 53 位以内保证 JS number 精确表示;冲突只会让两个 chunk 共用向量槽位(退化为漏检,不是错检)
	const big = (BigInt(h1) << 22n) | BigInt(h2 & 0x3fffff);
	return Number(big & ((1n << 53n) - 1n)) + 1;
}

const queue: Array<{ tenantId: string; documentId: string; category: string; chunks: string[] }> = [];
let draining: Promise<void> | null = null;
const indexedDocuments = new Set<string>();

/**
 * 异步排队索引(不阻塞工具调用与入库返回):
 * 先算 embedding 落本地表,再尽力推 Milvus。同一文档重复入队只保留最后一次。
 */
export function queueDocumentVectors(db: DatabaseSync, input: { tenantId: string; documentId: string; category?: string; chunks: string[] }): void {
	if (!input.chunks.length) return;
	const key = `${input.tenantId}:${input.documentId}`;
	if (indexedDocuments.has(key)) return;
	indexedDocuments.add(key);
	queue.push({ tenantId: input.tenantId, documentId: input.documentId, category: input.category ?? "", chunks: input.chunks });
	void drainVectorQueue(db);
}

/** 排空队列(测试与 /reindex 需要确定完成时机)。 */
export function flushVectorQueue(db: DatabaseSync): Promise<void> {
	return drainVectorQueue(db);
}

function drainVectorQueue(db: DatabaseSync): Promise<void> {
	if (draining) return draining;
	draining = (async () => {
		while (queue.length > 0) {
			const job = queue.shift()!;
			const key = `${job.tenantId}:${job.documentId}`;
			try {
				await indexDocumentVectors(db, job);
			} catch (error) {
				console.warn(`[vector] 索引失败(${job.documentId}):`, error instanceof Error ? error.message : String(error));
			} finally {
				indexedDocuments.delete(key);
			}
		}
	})().finally(() => {
		draining = null;
	});
	return draining;
}

/** 为一篇文档的分块计算向量并落库(本地 + Milvus)。 */
export async function indexDocumentVectors(
	db: DatabaseSync,
	input: { tenantId: string; documentId: string; category?: string; chunks: string[] },
): Promise<{ local: number; remote: boolean }> {
	const { tenantId, documentId, chunks } = input;
	const category = input.category ?? "";
	const chunkIds = (db
		.prepare("SELECT id, chunk_index FROM knowledge_chunks WHERE tenant_id = ? AND document_id = ? ORDER BY chunk_index")
		.all(tenantId, documentId) as Array<{ id: string; chunk_index: number }>)
		.map((r) => r.id);
	if (chunkIds.length !== chunks.length) {
		console.warn(`[vector] 分块数不一致(库 ${chunkIds.length} / 待索引 ${chunks.length}),跳过`);
		return { local: 0, remote: false };
	}
	const vectors = await embedTextsSafe(chunks);
	const ins = db.prepare(
		`INSERT INTO knowledge_embeddings (id, tenant_id, document_id, chunk_id, chunk_index, dimension, model, vector_json)
		 VALUES (?,?,?,?,?,?,?,?)
		 ON CONFLICT(tenant_id, chunk_id) DO UPDATE SET vector_json = excluded.vector_json, dimension = excluded.dimension, model = excluded.model, chunk_index = excluded.chunk_index, document_id = excluded.document_id`,
	);
	db.exec("BEGIN");
	try {
		chunks.forEach((_, i) => {
			ins.run(newId(), tenantId, documentId, chunkIds[i], i, vectors[i]?.length ?? 0, embedModelName(), JSON.stringify(vectors[i] ?? []));
		});
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
	let remote = false;
	if (milvusEnabled()) {
		const records = chunks.map((_, i) => ({
			chunkPk: chunkPkOf(chunkIds[i]),
			tenantId,
			documentId,
			chunkId: chunkIds[i],
			chunkIndex: i,
			category,
		}));
		remote = await upsertVectors(records, vectors);
	}
	return { local: chunkIds.length, remote };
}

/** 删除文档向量(本地 + Milvus);文档覆盖入库时先清旧向量,避免脏命中。 */
export async function removeDocumentVectors(db: DatabaseSync, tenantId: string, documentIds: string[]): Promise<void> {
	if (!documentIds.length) return;
	const placeholders = documentIds.map(() => "?").join(",");
	db.prepare(`DELETE FROM knowledge_embeddings WHERE tenant_id = ? AND document_id IN (${placeholders})`).run(tenantId, ...documentIds);
	if (milvusEnabled()) await deleteVectorsByDocumentIds(tenantId, documentIds);
}

/**
 * 同步清理本地向量 + 异步清理远端(仓库层删除是同步函数,不能 await)。
 * 本地必须同步删,否则残留向量会让兜底检索命中已删除的话术。
 */
/**
 * 按 chunkId 清理(仓库层同步函数用)。
 * 必须按 chunkId 而不是 documentId:覆盖更新时新分块是全新的 chunkId,
 * 若按 documentId 走异步清远端,删除可能排在新写入之后,把刚写入的向量一起清掉。
 */
export function purgeChunkVectors(db: DatabaseSync, tenantId: string, ids: string[]): void {
	if (!ids.length) return;
	const ph = ids.map(() => "?").join(",");
	db.prepare(`DELETE FROM knowledge_embeddings WHERE tenant_id = ? AND chunk_id IN (${ph})`).run(tenantId, ...ids);
	if (milvusEnabled()) void removeChunkVectors(db, tenantId, ids).catch(() => undefined);
}

export function purgeDocumentVectors(db: DatabaseSync, tenantId: string, documentIds: string[]): void {
	if (!documentIds.length) return;
	const placeholders = documentIds.map(() => "?").join(",");
	db.prepare(`DELETE FROM knowledge_embeddings WHERE tenant_id = ? AND document_id IN (${placeholders})`).run(tenantId, ...documentIds);
	if (milvusEnabled()) {
		void deleteVectorsByDocumentIds(tenantId, documentIds).catch(() => undefined);
	}
}

/** 按 chunkId 删除向量(分块级重建用)。 */
export async function removeChunkVectors(db: DatabaseSync, tenantId: string, chunkIds: string[]): Promise<void> {
	if (!chunkIds.length) return;
	const placeholders = chunkIds.map(() => "?").join(",");
	db.prepare(`DELETE FROM knowledge_embeddings WHERE tenant_id = ? AND chunk_id IN (${placeholders})`).run(tenantId, ...chunkIds);
	if (milvusEnabled()) await deleteVectorsByChunkIds(tenantId, chunkIds);
}

/**
 * 语义检索:优先 Milvus,不可用则本地余弦扫描。
 * 返回 chunkId + 相似度,由调用方回 knowledge_chunks 取正文与标题。
 */
export async function searchSimilarChunks(
	db: DatabaseSync,
	tenantId: string,
	query: string,
	options: { topK?: number; category?: string; scoreThreshold?: number } = {},
): Promise<VectorHit[]> {
	const topK = Math.max(1, options.topK ?? config.vectorSearchTopK);
	const threshold = options.scoreThreshold ?? config.vectorScoreThreshold;
	if (!tenantId || !query.trim()) return [];
	const [vector] = await embedTextsSafe([query]);
	if (!vector || vector.length === 0) return [];
	if (milvusEnabled()) {
		const hits: MilvusSearchHit[] = await searchVectors(tenantId, vector, { topK, category: options.category, scoreThreshold: threshold });
		if (hits.length > 0 || (await milvusReachable())) {
			// Milvus 是异步写入且删除最终一致,可能残留本地已不存在的分块(进程被中断/库重置)。
			// 以本地 knowledge_chunks 为准做一次存在性校验,并顺手把这些孤儿向量清掉,避免命中"已删除的话术"。
			const live = filterExistingChunkIds(db, tenantId, hits.map((h) => h.chunkId));
			const stale = hits.map((h) => h.chunkId).filter((id) => !live.has(id));
			if (stale.length > 0) void removeChunkVectors(db, tenantId, stale).catch(() => undefined);
			return hits.filter((h) => live.has(h.chunkId)).map((h) => ({ chunkId: h.chunkId, score: h.score }));
		}
		console.warn("[vector] Milvus 不可达,降级本地向量检索");
	}
	return localCosineSearch(db, tenantId, vector, { topK, category: options.category, scoreThreshold: threshold });
}

/** 批量语义检索(质检里一次给多句,减少 embedding 往返与 Milvus 请求数)。 */
export async function searchSimilarChunksBatch(
	db: DatabaseSync,
	tenantId: string,
	queries: string[],
	options: { topK?: number; category?: string; scoreThreshold?: number } = {},
): Promise<VectorHit[][]> {
	if (queries.length === 0) return [];
	const threshold = options.scoreThreshold ?? config.vectorScoreThreshold;
	const topK = Math.max(1, options.topK ?? config.vectorSearchTopK);
	const vectors = await embedTextsSafe(queries);
	if (vectors.length === 0) return queries.map(() => []);
	if (milvusEnabled()) {
		const out: VectorHit[][] = [];
		const staleIds = new Set<string>();
		// 逐句检索:Milvus REST 的 data 虽支持多向量,但返回不标注归属句,逐句更可靠
		for (const vector of vectors) {
			const hits = await searchVectors(tenantId, vector, { topK, category: options.category, scoreThreshold: threshold });
			const ids = hits.map((h) => h.chunkId);
			const live = filterExistingChunkIds(db, tenantId, ids);
			for (const id of ids) if (!live.has(id)) staleIds.add(id);
			out.push(hits.filter((h) => live.has(h.chunkId)).map((h) => ({ chunkId: h.chunkId, score: h.score })));
		}
		if (staleIds.size > 0) void removeChunkVectors(db, tenantId, [...staleIds]).catch(() => undefined);
		if (out.length === queries.length) return out;
		console.warn("[vector] Milvus 批量结果不完整,降级本地向量检索");
	}
	return vectors.map((vector) => localCosineSearch(db, tenantId, vector, { topK, category: options.category, scoreThreshold: threshold }));
}

/** 本地兜底:对 knowledge_embeddings 全表余弦扫描(带 category 过滤)。 */
export function localCosineSearch(
	db: DatabaseSync,
	tenantId: string,
	vector: number[],
	options: { topK?: number; category?: string; scoreThreshold?: number },
): VectorHit[] {
	const topK = Math.max(1, options.topK ?? config.vectorSearchTopK);
	const threshold = options.scoreThreshold ?? config.vectorScoreThreshold;
	const rows = options.category
		? (db
				.prepare(
					`SELECT ke.chunk_id AS chunkId, ke.vector_json AS vectorJson
					 FROM knowledge_embeddings ke JOIN knowledge_documents kd ON kd.id = ke.document_id
					 WHERE ke.tenant_id = ? AND kd.category LIKE ?`,
				)
				.all(tenantId, `%${options.category}%`) as Array<{ chunkId: string; vectorJson: string }>)
		: (db
				.prepare("SELECT chunk_id AS chunkId, vector_json AS vectorJson FROM knowledge_embeddings WHERE tenant_id = ?")
				.all(tenantId) as Array<{ chunkId: string; vectorJson: string }>);
	const scored: VectorHit[] = [];
	for (const row of rows) {
		let v: number[];
		try {
			v = JSON.parse(row.vectorJson) as number[];
		} catch {
			continue;
		}
		const score = cosineSim(vector, v);
		if (score >= threshold) scored.push({ chunkId: row.chunkId, score });
	}
	return scored.sort((a, b) => b.score - a.score).slice(0, topK);
}

/**
 * 全量重建:把本地没有向量的分块补齐(首次接入 Milvus / 历史数据)。
 * 以 knowledge_chunks 为准,逐文档批量索引。
 */
export async function reindexAll(db: DatabaseSync, tenantId: string, limit = 50): Promise<{ documents: number; chunks: number }> {
	const rows = db
		.prepare(
			`SELECT kc.document_id AS documentId, GROUP_CONCAT(kc.id) AS chunkIds, kd.category AS category
			 FROM knowledge_chunks kc JOIN knowledge_documents kd ON kd.id = kc.document_id
			 WHERE kc.tenant_id = ? AND kc.id NOT IN (SELECT chunk_id FROM knowledge_embeddings WHERE tenant_id = ?)
			 GROUP BY kc.document_id ORDER BY MIN(kd.created_at) LIMIT ?`,
		)
		.all(tenantId, tenantId, limit) as Array<{ documentId: string; chunkIds: string; category: string | null }>;
	let chunks = 0;
	for (const row of rows) {
		const ids = String(row.chunkIds ?? "").split(",").filter(Boolean);
		const texts = (db
			.prepare(
				`SELECT content FROM knowledge_chunks WHERE tenant_id = ? AND document_id = ? AND id IN (${ids.map(() => "?").join(",")}) ORDER BY chunk_index`,
			)
			.all(tenantId, row.documentId, ...ids) as Array<{ content: string }>).map((r) => String(r.content ?? ""));
		const res = await indexDocumentVectors(db, { tenantId, documentId: row.documentId, category: row.category ?? "", chunks: texts });
		chunks += res.local;
	}
	return { documents: rows.length, chunks };
}

/** 过滤出本地 knowledge_chunks 里仍然存在的 chunkId(单次查询,避免 N+1)。 */
function filterExistingChunkIds(db: DatabaseSync, tenantId: string, chunkIds: string[]): Set<string> {
	const unique = [...new Set(chunkIds.filter(Boolean))];
	if (unique.length === 0) return new Set();
	const placeholders = unique.map(() => "?").join(",");
	const rows = db
		.prepare(`SELECT id FROM knowledge_chunks WHERE tenant_id = ? AND id IN (${placeholders})`)
		.all(tenantId, ...unique) as Array<{ id: string }>;
	return new Set(rows.map((r) => r.id));
}

/** 本地已索引的向量条数(健康检查与前端展示用)。 */
export function countLocalVectors(db: DatabaseSync, tenantId: string): number {
	const row = db.prepare("SELECT COUNT(*) AS n FROM knowledge_embeddings WHERE tenant_id = ?").get(tenantId) as { n: number };
	return Number(row?.n ?? 0);
}

let lastProbe: { ok: boolean; at: number } | undefined;

/** Milvus 可达性(30s 缓存,避免每句都做探针)。 */
export async function milvusReachable(): Promise<boolean> {
	if (!milvusEnabled()) return false;
	if (lastProbe && Date.now() - lastProbe.at < 30_000) return lastProbe.ok;
	const { milvusHealthy } = await import("./milvus.js");
	const ok = await milvusHealthy();
	lastProbe = { ok, at: Date.now() };
	return ok;
}

export function resetMilvusProbeCache(): void {
	lastProbe = undefined;
}

function embedModelName(): string {
	return `bge-small-zh-v1.5/${config.vectorDimension}`;
}

function newId(): string {
	return createHash("sha1").update(String(Math.random()) + Date.now()).digest("hex");
}