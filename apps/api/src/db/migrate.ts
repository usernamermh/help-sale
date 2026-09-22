import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

export const MIGRATION_VERSION = 29;

const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "schema.sql");

export function migrate(db: DatabaseSync): void {
	const current = db.prepare("PRAGMA user_version").get() as { user_version: number };
	if (current.user_version >= MIGRATION_VERSION) return;

	// v10:先补 knowledge_documents.category 列,再执行全量 schema(索引引用该列)
	if (current.user_version < 10) {
		const hasKd = db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_documents'")
			.get();
		if (hasKd) {
			const kdCols = db.prepare("PRAGMA table_info(knowledge_documents)").all() as Array<{ name: string }>;
			if (!kdCols.some((col) => col.name === "category")) {
				db.exec("ALTER TABLE knowledge_documents ADD COLUMN category TEXT;");
			}
		}
	}

	// v14:先补 analyses.request_hash 列,再执行全量 schema(schema 中的部分唯一索引引用该列)
	if (current.user_version < 14) {
		const hasAnalyses = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'analyses'").get();
		if (hasAnalyses) {
			const anaCols = db.prepare("PRAGMA table_info(analyses)").all() as Array<{ name: string }>;
			if (!anaCols.some((col) => col.name === "request_hash")) {
				db.exec("ALTER TABLE analyses ADD COLUMN request_hash TEXT;");
			}
		}
	}
	// v15:客户意向车型列表(customers.intended_vehicles,JSON 数组)
	if (current.user_version < 15) {
		const hasCustomers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'customers'").get();
		if (hasCustomers) {
			const custCols = db.prepare("PRAGMA table_info(customers)").all() as Array<{ name: string }>;
			if (!custCols.some((col) => col.name === "intended_vehicles")) {
				db.exec("ALTER TABLE customers ADD COLUMN intended_vehicles TEXT;");
			}
		}
	}
	// v16:客户地区来源(customers.region)
	if (current.user_version < 16) {
		const hasCustomers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'customers'").get();
		if (hasCustomers) {
			const custCols = db.prepare("PRAGMA table_info(customers)").all() as Array<{ name: string }>;
			if (!custCols.some((col) => col.name === "region")) {
				db.exec("ALTER TABLE customers ADD COLUMN region TEXT;");
			}
		}
	}

	const sql = readFileSync(schemaPath, "utf8");
	db.exec(sql);
	// v8:重建 customer_tags(唯一约束改为 客户+标签,支持跨分析权重累加)
	if (current.user_version < 8) {
		db.exec("DROP TABLE IF EXISTS customer_tags;");
		db.exec(
			`CREATE TABLE IF NOT EXISTS customer_tags (
				id TEXT PRIMARY KEY,
				tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
				customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
				tag TEXT NOT NULL,
				kind TEXT NOT NULL DEFAULT 'auto',
				source TEXT,
				weight INTEGER NOT NULL DEFAULT 1,
				created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
				updated_at TEXT,
				UNIQUE (tenant_id, customer_id, tag)
			);`,
		);
	}
	// v13:门店/销售/成交/对话原文/工具缓存;并给 customers、conversations 补列
	if (current.user_version < 13) {
		const addCol = (table: string, col: string, ddl: string) => {
			const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
			if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl};`);
		};
		addCol("customers", "phone", "TEXT");
		addCol("conversations", "sales_id", "TEXT REFERENCES sales(id) ON DELETE SET NULL");
		addCol("conversations", "sales_phone", "TEXT");
		addCol("conversations", "store_id", "TEXT REFERENCES stores(id) ON DELETE SET NULL");
		addCol("conversations", "followup_advice", "TEXT");
	}

	// v14:分析请求哈希缓存(相同请求直接复用分析结果,不再调用模型)
	if (current.user_version < 14) {
		const cols = db.prepare("PRAGMA table_info(analyses)").all() as Array<{ name: string }>;
		if (!cols.some((col) => col.name === "request_hash")) {
			db.exec("ALTER TABLE analyses ADD COLUMN request_hash TEXT;");
		}
		db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_analyses_req_hash ON analyses (tenant_id, request_hash) WHERE request_hash IS NOT NULL;");
	}

	// v17:销售漏斗阶段 + 试驾管理 + 成交明细(车型/折扣)
	if (current.user_version < 17) {
		const addCol = (table: string, col: string, ddl: string) => {
			const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
			if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl};`);
		};
		addCol("customers", "funnel_stage", "TEXT");
		addCol("customers", "lost_reason", "TEXT");
		addCol("customers", "funnel_stage_changed_at", "TEXT");
		addCol("deals", "vehicle_id", "TEXT");
		addCol("deals", "discount_amount", "REAL NOT NULL DEFAULT 0");
		addCol("next_step_tasks", "sales_id", "TEXT REFERENCES sales(id) ON DELETE SET NULL");
		// 存量客户阶段回填:成交→closed_won;洽谈中/未知→contacted
		db.exec(`UPDATE customers SET funnel_stage = CASE
			WHEN stage IN ('成交','已成交','closed') THEN 'closed_won'
			WHEN stage IS NOT NULL AND stage <> '' THEN 'contacted'
			ELSE funnel_stage END,
			funnel_stage_changed_at = COALESCE(funnel_stage_changed_at, updated_at)
			WHERE funnel_stage IS NULL;`);
	}
	// v23:自定义任务间隔周期字段 + 内置任务启停开关表
	if (current.user_version < 23) {
		const addCol = (table: string, col: string, ddl: string) => {
			const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
			if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl};`);
		};
		addCol("automation_jobs", "interval_days", "INTEGER");
	}
	// v24:自定义任务间隔单位(day/hour)
	if (current.user_version < 24) {
		const cols = db.prepare("PRAGMA table_info(automation_jobs)").all() as Array<{ name: string }>;
		if (!cols.some((c) => c.name === "interval_unit")) {
			db.exec("ALTER TABLE automation_jobs ADD COLUMN interval_unit TEXT NOT NULL DEFAULT 'day';");
		}
	}
	// v25:一次性定时任务(指定日期 YYYY-MM-DD,到点执行一次后自动停用)
	if (current.user_version < 25) {
		const cols = db.prepare("PRAGMA table_info(automation_jobs)").all() as Array<{ name: string }>;
		if (!cols.some((c) => c.name === "once_date")) {
			db.exec("ALTER TABLE automation_jobs ADD COLUMN once_date TEXT;");
		}
	}
	// v26:真实数据导入扩展字段(话术点/对话/消息)
	if (current.user_version < 26) {
		const addCol = (table: string, col: string, ddl: string) => {
			const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
			if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl};`);
		};
		addCol("knowledge_documents", "source_id", "TEXT");
		addCol("knowledge_documents", "key_content", "TEXT");
		addCol("knowledge_documents", "kind_code", "TEXT");
		addCol("knowledge_documents", "necessity", "INTEGER");
		addCol("knowledge_documents", "score", "INTEGER");
		addCol("knowledge_documents", "status", "INTEGER");
		addCol("knowledge_documents", "tag_ids", "TEXT");
		addCol("knowledge_documents", "kind_path_json", "TEXT");
		addCol("knowledge_documents", "cust_id", "TEXT");
		addCol("conversations", "source_id", "TEXT");
		addCol("conversations", "audio_date", "TEXT");
		addCol("conversations", "complex_url", "TEXT");
		addCol("conversations", "info_json", "TEXT");
		addCol("conversations", "raw_json", "TEXT");
		addCol("conversation_messages", "start_ms", "INTEGER");
		addCol("conversation_messages", "end_ms", "INTEGER");
		addCol("conversation_messages", "speaker", "TEXT");
		addCol("conversation_messages", "file_start_time", "TEXT");
	}
	// v29:修复 FTS 删除触发器(node:sqlite 下 'delete' 命令不可用,改为直接删除行)
	if (current.user_version < 29) {
		db.exec("DROP TRIGGER IF EXISTS knowledge_chunks_ad;");
		db.exec("CREATE TRIGGER IF NOT EXISTS knowledge_chunks_ad AFTER DELETE ON knowledge_chunks BEGIN DELETE FROM knowledge_chunks_fts WHERE chunk_id = old.id; END;");
	}
	// v28:话术沉淀候选二次确认(建议动作/相似度/旧版本快照)
	if (current.user_version < 28) {
		const addCol = (table: string, col: string, ddl: string) => {
			const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
			if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl};`);
		};
		addCol("knowledge_candidates", "suggest_action", "TEXT");
		addCol("knowledge_candidates", "matched_title", "TEXT");
		addCol("knowledge_candidates", "similarity_score", "REAL");
		addCol("knowledge_candidates", "old_title", "TEXT");
		addCol("knowledge_candidates", "old_content", "TEXT");
		addCol("knowledge_candidates", "review_note", "TEXT");
	}
	db.exec(`PRAGMA user_version = ${MIGRATION_VERSION}`);
}