/** Milvus REST 客户端(集合/写入/检索/删除) */
import { config } from "../env.js";

/**
 * Milvus v2.4 RESTful v2 客户端(直连 proxy 19530,不引入官方 SDK)。
 * 契约要点(已按 v2.4.15 实测确认):
 * - 建集合用 schema.fields[],字段键名是 fieldName(不是 name);
 *   主键 { isPrimary: true },向量 { isVector: true },类型参数统一放 elementTypeParams
 *   (向量 dim、VarChar max_length 都写在这里,写成 dim / maxLength 会被服务端忽略并报缺参)。
 * - upsert 幂等:同主键覆盖,因此重建索引不需要先删。
 * - COSINE 的 distance 直接就是相似度(自匹配=1),不需要 1-d 转换。
 * - 删除是异步生效,读侧统一用 consistencyLevel=Strong,避免刚删的向量仍被命中。
 * 服务不可用时所有方法返回安全默认值(false / 空数组),由调用方降级到本地实现。
 */
export interface MilvusRecord {
	chunkPk: number;
	tenantId: string;
	documentId: string;
	chunkId: string;
	chunkIndex: number;
	category: string;
}

export interface MilvusSearchHit {
	chunkId: string;
	documentId: string;
	chunkIndex: number;
	category: string;
	score: number;
}

const OUTPUT_FIELDS = ["chunkId", "documentId", "chunkIndex", "category"] as const;

export function milvusEnabled(): boolean {
	return config.vectorEnabled && config.vectorProvider === "milvus";
}

async function rest<T>(path: string, body: Record<string, unknown>): Promise<T | null> {
	const url = config.vectorBaseUrl.replace(/\/+$/, "") + path;
	const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
	if (config.vectorToken) headers.authorization = `Bearer ${config.vectorToken}`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), config.vectorTimeoutMs);
	try {
		const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ database: config.vectorDatabase, ...body }), signal: controller.signal });
		const text = await res.text();
		let json: { code?: number; message?: string; data?: unknown };
		try {
			json = JSON.parse(text) as typeof json;
		} catch {
			throw new Error(`响应不是 JSON(HTTP ${res.status}):${text.slice(0, 160)}`);
		}
		if (json.code !== 0) throw new Error(`code=${json.code} ${json.message ?? ""}`.trim());
		return (json.data ?? null) as T | null;
	} catch (error) {
		const message = error instanceof Error ? (error.name === "AbortError" ? `请求超时(${config.vectorTimeoutMs}ms)` : error.message) : String(error);
		console.warn(`[milvus] ${path} 失败: ${message}`);
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/** 建集合所需的固定 schema(维度/度量/索引类型均来自 yaml)。 */
function collectionSchema(dim: number) {
	return {
		autoID: false,
		enableDynamicField: false,
		fields: [
			{ fieldName: "chunkPk", dataType: "Int64", isPrimary: true },
			{ fieldName: "vector", dataType: "FloatVector", isVector: true, elementTypeParams: { dim } },
			{ fieldName: "tenantId", dataType: "VarChar", elementTypeParams: { max_length: 64 } },
			{ fieldName: "documentId", dataType: "VarChar", elementTypeParams: { max_length: 64 } },
			{ fieldName: "chunkId", dataType: "VarChar", elementTypeParams: { max_length: 64 } },
			{ fieldName: "chunkIndex", dataType: "Int64" },
			{ fieldName: "category", dataType: "VarChar", elementTypeParams: { max_length: 128 } },
		],
	};
}

/** 集合是否存在(不存在时创建 + 建索引)。失败返回 false,调用方降级。 */
export async function ensureCollection(): Promise<boolean> {
	if (!milvusEnabled()) return false;
	const listed = await rest<{ collections?: string[] } | string[]>("/v2/vectordb/collections/list", {});
	const names = Array.isArray(listed) ? listed : (listed?.collections ?? []);
	if (names.includes(config.vectorCollection)) return true;
	const created = await rest<unknown>("/v2/vectordb/collections/create", {
		collectionName: config.vectorCollection,
		schema: collectionSchema(config.vectorDimension),
		indexParams: [{ fieldName: "vector", metricType: config.vectorMetric, indexType: config.vectorIndexType, params: { nlist: config.vectorIndexNlist } }],
	});
	if (created === null) return false;
	console.log(`[milvus] 已创建集合 ${config.vectorCollection}(dim=${config.vectorDimension}, metric=${config.vectorMetric}, index=${config.vectorIndexType})`);
	return true;
}

/** 批量写入(upsert 语义,同主键覆盖)。返回是否成功。 */
export async function upsertVectors(records: MilvusRecord[], vectors: number[][]): Promise<boolean> {
	if (!milvusEnabled() || records.length === 0) return records.length === 0;
	if (records.length !== vectors.length) throw new Error("records 与 vectors 数量不一致");
	if (!(await ensureCollection())) return false;
	const size = Math.max(1, config.vectorEmbedBatch);
	for (let i = 0; i < records.length; i += size) {
		const slice = records.slice(i, i + size);
		const data = slice.map((r, j) => ({ ...r, vector: vectors[i + j] }));
		const res = await rest<{ upsertCount?: number }>("/v2/vectordb/entities/upsert", { collectionName: config.vectorCollection, data });
		if (res === null) return false;
	}
	return true;
}

/**
 * 向量检索:filter 强制带 tenantId(多租户隔离在数据层而非应用层)。
 * category 非空时追加等值过滤;scoreThreshold 用于服务端结果的后置裁剪。
 */
export async function searchVectors(
	tenantId: string,
	vector: number[],
	options: { topK?: number; category?: string; scoreThreshold?: number } = {},
): Promise<MilvusSearchHit[]> {
	if (!milvusEnabled() || !tenantId) return [];
	if (!(await ensureCollection())) return [];
	const topK = Math.max(1, Math.min(options.topK ?? config.vectorSearchTopK, 100));
	const threshold = options.scoreThreshold ?? config.vectorScoreThreshold;
	const filter = options.category
		? `tenantId == ${quote(tenantId)} and category == ${quote(options.category)}`
		: `tenantId == ${quote(tenantId)}`;
	const res = await rest<Array<Record<string, unknown>>>("/v2/vectordb/entities/search", {
		collectionName: config.vectorCollection,
		data: [vector],
		annsField: "vector",
		filter,
		limit: topK,
		outputFields: [...OUTPUT_FIELDS],
		consistencyLevel: "Strong",
	});
	if (!Array.isArray(res)) return [];
	return res
		.map((row) => ({
			chunkId: String(row.chunkId ?? ""),
			documentId: String(row.documentId ?? ""),
			chunkIndex: Number(row.chunkIndex ?? 0),
			category: String(row.category ?? ""),
			// COSINE:distance 即余弦相似度(自匹配=1);其他度量按 1-distance 处理
			score: config.vectorMetric === "COSINE" ? Number(row.distance ?? 0) : 1 - Number(row.distance ?? 0),
		}))
		.filter((h) => h.chunkId && h.score >= threshold)
		.slice(0, topK);
}

/** 按过滤条件删除(用于文档覆盖/租户清理)。 */
export async function deleteVectors(tenantId: string, filter: string): Promise<boolean> {
	if (!milvusEnabled() || !tenantId) return false;
	const res = await rest<unknown>("/v2/vectordb/entities/delete", {
		collectionName: config.vectorCollection,
		filter: `tenantId == ${quote(tenantId)} and (${filter})`,
	});
	return res !== null;
}

export async function deleteVectorsByChunkIds(tenantId: string, chunkIds: string[]): Promise<boolean> {
	if (!chunkIds.length) return true;
	return deleteVectors(tenantId, `chunkId in [${chunkIds.map(quote).join(",")}]`);
}

export async function deleteVectorsByDocumentIds(tenantId: string, documentIds: string[]): Promise<boolean> {
	if (!documentIds.length) return true;
	return deleteVectors(tenantId, `documentId in [${documentIds.map(quote).join(",")}]`);
}

/**
 * Milvus 侧条数(仅供诊断展示,
 * 注意:count(*) 在未落盘的 growing segment 上可能滞后甚至返回 0,
 * 而向量此时已可被 search 命中 —— 因此不能用它判断写入是否成功。
 */
export async function countVectors(tenantId: string): Promise<number | null> {
	if (!milvusEnabled()) return null;
	const res = await rest<Array<Record<string, unknown>>>("/v2/vectordb/entities/query", {
		collectionName: config.vectorCollection,
		filter: `tenantId == ${quote(tenantId)}`,
		outputFields: ["count(*)"],
		consistencyLevel: "Strong",
	});
	if (!Array.isArray(res) || res.length === 0) return null;
	return Number(Object.values(res[0])[0] ?? 0);
}

/** 健康探针:集合能否列出(供 /health 与降级判断)。 */
export async function milvusHealthy(): Promise<boolean> {
	if (!milvusEnabled()) return false;
	const listed = await rest<unknown>("/v2/vectordb/collections/list", {});
	return listed !== null;
}

/** Milvus 表达式字符串字面量:双引号包裹,内部转义。 */
function quote(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}