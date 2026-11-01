-- 分区与归档:把增长最快的事件/消息表改成按 created_at 的月分区。
--
-- 为什么单独一个脚本:分区要求"分区列出现在每个唯一键里",所以主键要从 (tenant_id, id)
-- 变成 (tenant_id, id, created_at);这类重建表不适合放进启动自愈(线上有数据,代价大)。
--
-- 用法(维护窗口执行,大表请用 gh-ost / pt-osc 的在线 DDL):
--   mysql -h <host> -u <admin> -p <db> < scripts/mysql-partition.sql
--
-- 归档方式:历史分区不再需要时,用
--   ALTER TABLE agent_events DROP PARTITION p2025_01;          -- 秒级删除整月数据,不产生大事务
--   ALTER TABLE agent_events REORGANIZE PARTITION pmax INTO (...)  -- 加下个月的分区
-- 归档到冷库前先 SELECT ... FROM agent_events PARTITION (p2025_01) 导出。

-- 1) agent_events:主键补上 created_at(分区列),再按 created_at 做月分区
ALTER TABLE `agent_events` DROP PRIMARY KEY, ADD PRIMARY KEY (`tenant_id`, `id`, `created_at`);
ALTER TABLE `agent_events`
  PARTITION BY RANGE COLUMNS(`created_at`) (
    PARTITION p_min VALUES LESS THAN ('2025-01'),
    PARTITION p2026_09 VALUES LESS THAN ('2026-09'),
    PARTITION p2026_10 VALUES LESS THAN ('2026-10'),
    PARTITION p2026_11 VALUES LESS THAN ('2026-11'),
    PARTITION p2026_12 VALUES LESS THAN ('2026-12'),
    PARTITION p2027_01 VALUES LESS THAN ('2027-01'),
    PARTITION pmax VALUES LESS THAN (MAXVALUE)
  );

-- 2) weixin_messages:同上
ALTER TABLE `weixin_messages` DROP PRIMARY KEY, ADD PRIMARY KEY (`tenant_id`, `id`, `created_at`);
ALTER TABLE `weixin_messages`
  PARTITION BY RANGE COLUMNS(`created_at`) (
    PARTITION p_min VALUES LESS THAN ('2025-01'),
    PARTITION p2026_09 VALUES LESS THAN ('2026-09'),
    PARTITION p2026_10 VALUES LESS THAN ('2026-10'),
    PARTITION p2026_11 VALUES LESS THAN ('2026-11'),
    PARTITION p2026_12 VALUES LESS THAN ('2026-12'),
    PARTITION p2027_01 VALUES LESS THAN ('2027-01'),
    PARTITION pmax VALUES LESS THAN (MAXVALUE)
  );

-- 说明:
--   * created_at 是零填充的 ISO 字符串('2026-10-30T03:48:01.379Z'),按字符串比较与按时间比较同序,
--     所以 RANGE COLUMNS 直接按前缀分区即可;空串/异常值会落进 p_min。
--   * pmax 是兜底分区:新月份先落在 pmax,到归档窗口再用 REORGANIZE 拆出来。
--   * 分区表的主键带上 created_at 后,(tenant_id, id) 仍是前缀,原来的按租户+id 定位照样走主键。
--   * 想回滚:先 ALTER TABLE ... REMOVE PARTITIONING;再 DROP PRIMARY KEY, ADD PRIMARY KEY (tenant_id, id)。