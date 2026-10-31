-- 索引清理(可选,一次性执行)
-- 用法:mysql -h <host> -u <admin> -p <db> < scripts/mysql-index-cleanup.sql
--
-- 背景:早期 schema 里有几个"跨租户全局唯一"的索引。租户隔离与分片都要求
-- 唯一性落在"租户内",所以这些索引在 schema 里已经改成 (tenant_id, ...);
-- 老库里旧索引不会被自动删除(启动自愈只做"加列/放宽列/加索引",不删任何东西),
-- 需要时用本脚本手工清掉。

-- knowledge_embeddings.chunk_id 是 UUID,全局唯一没有业务意义;
-- 租户内唯一性已由 uq_ke_tenant_chunk (tenant_id, chunk_id) 保证。
ALTER TABLE knowledge_embeddings DROP INDEX uq_ke_chunk;

-- 若 (tenant_id, chunk_id) 上同时存在普通索引与唯一索引,可删掉普通的那个(可选):
-- ALTER TABLE knowledge_embeddings DROP INDEX idx_ke_tenant_chunk;