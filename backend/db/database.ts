import { DatabaseSync } from "node:sqlite";
import { migrate } from "./migrate.js";

export function openDatabase(databasePath: string): DatabaseSync {
	const db = new DatabaseSync(databasePath);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA busy_timeout = 5000");
	db.exec("PRAGMA foreign_keys = ON");
	migrate(db);
	return db;
}

// db.exec(...)：执行一段 SQL，不返回结果集，适合设置类语句。
// PRAGMA：SQLite 特有的指令，用来查询或设置数据库行为。
// journal_mode = WAL：把日志模式设为 Write-Ahead Logging（预写日志）。
	// 默认模式（DELETE）下，写操作会锁住整个数据库，读写互斥。
	// WAL 模式下，读和写可以并发进行，写入性能更好，更适合多读少写或读写混合的场景。
	// 代价是会产生 -wal 和 -shm 两个附属文件。

// busy_timeout = 5000：设置忙碌超时为 5000 毫秒（5 秒）。
	// 当数据库被其他连接锁住时，当前连接不会立刻报 “database is locked” 错误，而是等待最多 5 秒，期间不断重试。
	// 超过 5 秒还拿不到锁，才抛错。这能有效缓解并发写入时的锁冲突。

// foreign_keys = ON：开启外键约束。
	// SQLite 默认不强制外键（为了兼容旧行为），必须显式打开。
	// 打开后，前面 customers 表里的 REFERENCES tenants(id) ON DELETE CASCADE 才会真正生效：插入不存在的 tenant_id 会报错，删除租户会级联删除客户。