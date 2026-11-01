-- 主键复合化: PR 将租户表的主键从 (id) 改为 (tenant_id, id)
-- 目的:分片后同一租户数据聚簇、按租户范围归档/删除、减少随机 UUID 主键的写放大
--
-- 用法(建议在维护窗口执行,大表请用在线 DDL 工具 gh-ost / pt-osc 代替本脚本):
--   mysql -h <host> -u <admin> -p <db> < scripts/mysql-pk-rebuild.sql
--
-- 说明:启动自愈不会自动改主键(重建表代价大),只会在日志里提示待迁移的表。

ALTER TABLE `customers` DROP PRIMARY KEY, ADD PRIMARY KEY (`tenant_id`, `id`);
ALTER TABLE `knowledge_documents` DROP PRIMARY KEY, ADD PRIMARY KEY (`tenant_id`, `id`);
ALTER TABLE `knowledge_chunks` DROP PRIMARY KEY, ADD PRIMARY KEY (`tenant_id`, `id`);
ALTER TABLE `next_step_tasks` DROP PRIMARY KEY, ADD PRIMARY KEY (`tenant_id`, `id`);
ALTER TABLE `digests` DROP PRIMARY KEY, ADD PRIMARY KEY (`tenant_id`, `id`);
ALTER TABLE `knowledge_candidates` DROP PRIMARY KEY, ADD PRIMARY KEY (`tenant_id`, `id`);
ALTER TABLE `agent_events` DROP PRIMARY KEY, ADD PRIMARY KEY (`tenant_id`, `id`);
ALTER TABLE `customer_tags` DROP PRIMARY KEY, ADD PRIMARY KEY (`tenant_id`, `id`);
ALTER TABLE `notification_logs` DROP PRIMARY KEY, ADD PRIMARY KEY (`tenant_id`, `id`);
ALTER TABLE `conversations` DROP PRIMARY KEY, ADD PRIMARY KEY (`tenant_id`, `id`);
ALTER TABLE `agent_threads` DROP PRIMARY KEY, ADD PRIMARY KEY (`tenant_id`, `id`);
ALTER TABLE `agent_thread_messages` DROP PRIMARY KEY, ADD PRIMARY KEY (`tenant_id`, `id`);
ALTER TABLE `workflows` DROP PRIMARY KEY, ADD PRIMARY KEY (`tenant_id`, `id`);
ALTER TABLE `workflow_runs` DROP PRIMARY KEY, ADD PRIMARY KEY (`tenant_id`, `id`);
ALTER TABLE `knowledge_embeddings` DROP PRIMARY KEY, ADD PRIMARY KEY (`tenant_id`, `id`);
ALTER TABLE `stores` DROP PRIMARY KEY, ADD PRIMARY KEY (`tenant_id`, `id`);
ALTER TABLE `sales` DROP PRIMARY KEY, ADD PRIMARY KEY (`tenant_id`, `id`);
ALTER TABLE `conversation_messages` DROP PRIMARY KEY, ADD PRIMARY KEY (`tenant_id`, `id`);
ALTER TABLE `deals` DROP PRIMARY KEY, ADD PRIMARY KEY (`tenant_id`, `id`);
ALTER TABLE `tool_call_cache` DROP PRIMARY KEY, ADD PRIMARY KEY (`tenant_id`, `id`);
ALTER TABLE `agent_plans` DROP PRIMARY KEY, ADD PRIMARY KEY (`tenant_id`, `id`);
ALTER TABLE `automation_jobs` DROP PRIMARY KEY, ADD PRIMARY KEY (`tenant_id`, `id`);
ALTER TABLE `automation_runs` DROP PRIMARY KEY, ADD PRIMARY KEY (`tenant_id`, `id`);
ALTER TABLE `builtin_job_settings` DROP PRIMARY KEY, ADD PRIMARY KEY (`tenant_id`, `id`);
ALTER TABLE `kanban_cards` DROP PRIMARY KEY, ADD PRIMARY KEY (`tenant_id`, `id`);
ALTER TABLE `keyword_categories` DROP PRIMARY KEY, ADD PRIMARY KEY (`tenant_id`, `id`);
ALTER TABLE `keyword_hits` DROP PRIMARY KEY, ADD PRIMARY KEY (`tenant_id`, `id`);
ALTER TABLE `keywords` DROP PRIMARY KEY, ADD PRIMARY KEY (`tenant_id`, `id`);
ALTER TABLE `reflection_cases` DROP PRIMARY KEY, ADD PRIMARY KEY (`tenant_id`, `id`);
ALTER TABLE `thread_summaries` DROP PRIMARY KEY, ADD PRIMARY KEY (`tenant_id`, `id`);
ALTER TABLE `weixin_users` DROP PRIMARY KEY, ADD PRIMARY KEY (`tenant_id`, `id`);
ALTER TABLE `weixin_messages` DROP PRIMARY KEY, ADD PRIMARY KEY (`tenant_id`, `id`);
ALTER TABLE `weixin_threads` DROP PRIMARY KEY, ADD PRIMARY KEY (`tenant_id`, `id`);
