import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

export const MIGRATION_VERSION = 16;

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

	db.exec(`PRAGMA user_version = ${MIGRATION_VERSION}`);
}