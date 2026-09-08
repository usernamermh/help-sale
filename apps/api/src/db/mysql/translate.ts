/**
 * SQLite → MySQL SQL 方言转换(MySQL 模式专用,隔离在本子目录,不改仓库层)。
 * 转换规则:
 * - INSERT OR IGNORE → INSERT IGNORE
 * - ON CONFLICT(...) DO UPDATE SET → ON DUPLICATE KEY UPDATE(excluded.x → VALUES(x))
 * - strftime(...) → DATE_FORMAT(UTC_TIMESTAMP(3), ...)
 * - BEGIN → START TRANSACTION
 * - 知识库 FTS5 查询(knowledge_chunks_fts)降级为 LIKE:整段替换为等价参数数的 LIKE 查询,
 *   参数从 ["tenant","\"词\""] 改写为 ["tenant","%词%"]
 */
export interface TranslateResult {
	sql: string;
	params: unknown[];
}

const FTS_MARK = "FROM knowledge_chunks_fts f";

function toLikeSql(ftsSql: string): string {
	// 与原 FTS 查询字段结构一致,但改走 knowledge_chunks.content LIKE
	const sql = ftsSql.replace(/\s+/g, " ").trim();
	if (sql.includes("rank") || sql.includes("snippet(")) {
		return (
			"SELECT kc.id AS chunkId, kc.document_id AS documentId, kd.title, kd.category AS category, " +
			"kc.chunk_index AS chunkIndex, kc.content, CONCAT(substr(kc.content, 1, 80), '…') AS snippet " +
			"FROM knowledge_chunks kc JOIN knowledge_documents kd ON kd.id = kc.document_id " +
			"WHERE kc.tenant_id = ? AND kc.content LIKE ?"
		);
	}
	return sql.replace("knowledge_chunks_fts f", "knowledge_chunks kc").replace("f.chunk_id", "kc.id").replace("f.tenant_id", "kc.tenant_id");
}

export function translateSql(sql: string, params: unknown[] = []): TranslateResult {
	let out = sql;
	let outParams = params;

	// 1) 知识库 FTS 查询降级为 LIKE
	if (out.includes(FTS_MARK)) {
		out = toLikeSql(out);
		const tenantId = params[0];
		const ftsParam = String(params[1] ?? "");
		// FTS 参数格式为 "词"(带引号),LIKE 需要 %词%
		const term = ftsParam.replace(/^"|"$/g, "").trim();
		outParams = [tenantId, `%${term}%`];
	}

	// 2) INSERT OR IGNORE → INSERT IGNORE(仅语句首部)
	out = out.replace(/^INSERT\s+OR\s+IGNORE\s+/i, "INSERT IGNORE ");

	// 3) ON CONFLICT(..) DO UPDATE SET → ON DUPLICATE KEY UPDATE(excluded.x → VALUES(x))
	out = out.replace(/ON\s+CONFLICT\s*\([^)]*\)\s+DO\s+UPDATE\s+SET/gi, "ON DUPLICATE KEY UPDATE");
	out = out.replace(/\bexcluded\.(\w+)/g, "VALUES($1)");

	// 4) strftime('...','now') → MySQL 时间函数
	out = out.replace(/strftime\('%Y-%m-%dT%H:%M:%fZ','now'\)/g, "DATE_FORMAT(UTC_TIMESTAMP(3),'%Y-%m-%dT%H:%i:%s.%f')");

	// 5) 事务关键字
	const trimmed = out.trim().toUpperCase();
	if (trimmed === "BEGIN") out = "START TRANSACTION";
	if (trimmed === "COMMIT" || trimmed === "ROLLBACK") out = trimmed;

	// 6) MySQL 保留字:业务列 key 统一反引号转义(customers.key)
	out = out.replace(/\bkey\b/g, "`key`");

	return { sql: out, params: outParams };
}