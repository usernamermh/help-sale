import { describe, expect, it } from "vitest";
import { translateSql } from "./translate.js";

describe("translateSql SQLite → MySQL", () => {
	it("strftime 时间戳转为 MySQL 时间函数", () => {
		const { sql } = translateSql(
			"UPDATE customers SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
			["x"],
		);
		expect(sql).toContain("DATE_FORMAT(UTC_TIMESTAMP(3),'%Y-%m-%dT%H:%i:%s.%f')");
		expect(sql).not.toContain("strftime");
	});

	it("INSERT OR IGNORE 转为 INSERT IGNORE", () => {
		const { sql } = translateSql("INSERT OR IGNORE INTO conversations (id) VALUES (?)", ["c1"]);
		expect(sql.startsWith("INSERT IGNORE INTO conversations")).toBe(true);
	});

	it("ON CONFLICT ... DO UPDATE 转为 ON DUPLICATE KEY UPDATE,excluded 转 VALUES", () => {
		const { sql } = translateSql(
			"INSERT INTO tool_call_cache (id, result_json, last_used_at) VALUES (?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(tenant_id, tool_name, cache_key) DO UPDATE SET result_json = excluded.result_json, last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')",
			["id1", "{}"],
		);
		expect(sql).toContain("ON DUPLICATE KEY UPDATE");
		expect(sql).toContain("result_json = VALUES(result_json)");
		expect(sql).not.toContain("ON CONFLICT");
		expect(sql).not.toContain("excluded.");
	});

	it("事务关键字转换", () => {
		expect(translateSql("BEGIN").sql).toBe("START TRANSACTION");
		expect(translateSql("COMMIT").sql).toBe("COMMIT");
		expect(translateSql("ROLLBACK").sql).toBe("ROLLBACK");
	});

	it("知识库 FTS 查询降级为 LIKE 并改写参数", () => {
		const fts = `SELECT kc.id AS chunkId, kc.document_id AS documentId, kd.title, kd.category AS category,
			        kc.chunk_index AS chunkIndex, kc.content, snippet(knowledge_chunks_fts, 2, '【', '】', '…', 20) AS snippet
			 FROM knowledge_chunks_fts f
			 JOIN knowledge_chunks kc ON kc.id = f.chunk_id
			 JOIN knowledge_documents kd ON kd.id = kc.document_id
			 WHERE f.tenant_id = ? AND knowledge_chunks_fts MATCH ?
			 ORDER BY f.rank`;
		const { sql, params } = translateSql(fts, ["t1", "\"价格\""]);
		expect(sql).not.toContain("knowledge_chunks_fts");
		expect(sql).not.toContain("snippet(");
		expect(sql).toContain("FROM knowledge_chunks kc");
		expect(sql).toContain("LIKE ?");
		expect(params).toEqual(["t1", "%价格%"]);
		expect(sql).toContain("CONCAT(");
	});
});