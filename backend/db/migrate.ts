import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

export const MIGRATION_VERSION = 39;

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

	// v17:销售漏斗阶段 + 成交明细(折扣)
	if (current.user_version < 17) {
		const addCol = (table: string, col: string, ddl: string) => {
			const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
			if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl};`);
		};
		addCol("customers", "funnel_stage", "TEXT");
		addCol("customers", "lost_reason", "TEXT");
		addCol("customers", "funnel_stage_changed_at", "TEXT");
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
	// v30:关键词库表(自由抽取入库/严格匹配回写/用户增删改查)
	if (current.user_version < 30) {
		db.exec(`CREATE TABLE IF NOT EXISTS keywords (
			id TEXT PRIMARY KEY,
			tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
			keyword TEXT NOT NULL,
			category TEXT,
			source TEXT NOT NULL DEFAULT 'manual',
			hit_count INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
			updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
			UNIQUE (tenant_id, keyword)
		);`);
		db.exec(`CREATE INDEX IF NOT EXISTS idx_keywords_tenant ON keywords (tenant_id, keyword);`);
	}
	// v31:关键词三级分类目录(category_l1/l2/l3)
	if (current.user_version < 31) {
		const addCol = (table: string, col: string, ddl: string) => {
			const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
			if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl};`);
		};
		addCol("keywords", "category_l1", "TEXT");
		addCol("keywords", "category_l2", "TEXT");
		addCol("keywords", "category_l3", "TEXT");
	}
	// v32:独立分类目录树(增删改查)
	if (current.user_version < 32) {
		db.exec(`CREATE TABLE IF NOT EXISTS keyword_categories (
			id TEXT PRIMARY KEY,
			tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
			parent_id TEXT REFERENCES keyword_categories(id) ON DELETE CASCADE,
			name TEXT NOT NULL,
			level INTEGER NOT NULL DEFAULT 1,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
			updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
			UNIQUE (tenant_id, parent_id, name)
		);`);
		db.exec(`CREATE INDEX IF NOT EXISTS idx_kc_parent ON keyword_categories (tenant_id, parent_id);`);
	}
	// v33:agent_events / agent_plans 增加 thread_id(删除会话时级联清理该会话的运行记录)
	if (current.user_version < 33) {
		const addCol = (table: string, col: string, ddl: string) => {
			const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
			if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl};`);
		};
		addCol("agent_events", "thread_id", "TEXT");
		addCol("agent_plans", "thread_id", "TEXT");
	}
	// v34:工作流执行记录(workflow_runs)+ 扩展 workflows 定义列(version/status,兼容既有 enabled 表)
	if (current.user_version < 34) {
		const addCol = (table: string, col: string, ddl: string) => {
			const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
			if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl};`);
		};
		addCol("workflows", "version", "INTEGER NOT NULL DEFAULT 1");
		addCol("workflows", "status", "TEXT NOT NULL DEFAULT 'enabled'");
		db.exec(`CREATE TABLE IF NOT EXISTS workflow_runs (
			id TEXT PRIMARY KEY,
			tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
			workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
			status TEXT NOT NULL DEFAULT 'running',
			params_json TEXT,
			result_json TEXT,
			error TEXT,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
			completed_at TEXT
		);`);
		db.exec(`CREATE INDEX IF NOT EXISTS idx_wfr_wf ON workflow_runs (tenant_id, workflow_id, created_at DESC);`);
	}
	// v35:关键词命中去重明细(keyword_hits)+ 对话已挖掘标记
	if (current.user_version < 35) {
		db.exec(`CREATE TABLE IF NOT EXISTS keyword_hits (
			id TEXT PRIMARY KEY,
			tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
			keyword_id TEXT NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
			conversation_id TEXT,
			conversation_date TEXT,
			sales_name TEXT,
			customer_name TEXT,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
			UNIQUE (keyword_id, conversation_id)
		);`);
		db.exec(`CREATE INDEX IF NOT EXISTS idx_kh_keyword ON keyword_hits (tenant_id, keyword_id, created_at DESC);`);
		const cols = db.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>;
		if (!cols.some((c) => c.name === "keyword_mined_at")) {
			db.exec("ALTER TABLE conversations ADD COLUMN keyword_mined_at TEXT;");
		}
	}
	// v37:工作流来源与去重签名(origin / source_signature)+ 知识向量索引表(语义检索旁路)
	if (current.user_version < 37) {
		const addCol = (table: string, col: string, ddl: string) => {
			const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
			if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl};`);
		};
		addCol("workflows", "origin", "TEXT NOT NULL DEFAULT 'manual'");
		addCol("workflows", "source_signature", "TEXT");
		// 既有记录:已启用/停用的按人工预定义看待;此前挖掘产出若存在则归为 mined
		db.exec("UPDATE workflows SET origin = 'mined' WHERE source_signature IS NOT NULL;");
		db.exec("CREATE INDEX IF NOT EXISTS idx_wf_sig ON workflows (tenant_id, source_signature);");
		db.exec(`CREATE TABLE IF NOT EXISTS knowledge_embeddings (
			id TEXT PRIMARY KEY,
			tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
			document_id TEXT NOT NULL,
			chunk_id TEXT NOT NULL UNIQUE,
			chunk_index INTEGER NOT NULL,
			dimension INTEGER NOT NULL,
			model TEXT NOT NULL,
			vector_json TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
		);`);
		db.exec("CREATE INDEX IF NOT EXISTS idx_ke_tenant ON knowledge_embeddings (tenant_id, document_id);");
		db.exec("CREATE INDEX IF NOT EXISTS idx_ke_tenant_chunk ON knowledge_embeddings (tenant_id, chunk_id);");
	}
	db.exec(`PRAGMA user_version = ${MIGRATION_VERSION}`);
}
