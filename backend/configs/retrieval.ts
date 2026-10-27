import { bool, num, str, vectorProvider } from "./primitives.js";
import type { FileConfig } from "./file.js";
import type { RetrievalConfig } from "./types.js";

/**
 * 对应 help-sale.config.yaml 的 `knowledge`、`chunker`、`vector` 三段:检索条数、知识分块与向量后端。
 * enabled=false 时全部走本地(关键词用 FTS5,相似度用本地向量);provider=milvus 时才走向量库。
 * 全部必填(不启用向量也要显式写 enabled: false 与其余各项),代码里不提供任何默认值。
 */
export function loadRetrievalConfig(file: FileConfig): RetrievalConfig {
	return {
		knowledgeSearchLimit: num(file.knowledge?.searchLimit, "knowledge.searchLimit"),
		chunkerSize: num(file.chunker?.size, "chunker.size"),
		chunkerOverlap: num(file.chunker?.overlap, "chunker.overlap"),
		vectorEnabled: bool(file.vector?.enabled, "vector.enabled"),
		vectorProvider: vectorProvider(file.vector?.provider, "vector.provider"),
		vectorBaseUrl: str(file.vector?.baseUrl, "vector.baseUrl"),
		vectorDatabase: str(file.vector?.database, "vector.database"),
		vectorCollection: str(file.vector?.collection, "vector.collection"),
		vectorToken: str(file.vector?.token, "vector.token"),
		vectorDimension: num(file.vector?.dimension, "vector.dimension"),
		vectorMetric: str(file.vector?.metricType, "vector.metricType"),
		vectorIndexType: str(file.vector?.indexType, "vector.indexType"),
		vectorIndexNlist: num(file.vector?.indexNlist, "vector.indexNlist"),
		vectorSearchTopK: num(file.vector?.searchTopK, "vector.searchTopK"),
		vectorScoreThreshold: num(file.vector?.scoreThreshold, "vector.scoreThreshold"),
		vectorTimeoutMs: num(file.vector?.timeoutMs, "vector.timeoutMs"),
		vectorEmbedBatch: num(file.vector?.embedBatch, "vector.embedBatch"),
	};
}
