-- 业务库 v1:租户 / 客户 / 知识库 / 分析结果
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tenants (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	slug TEXT NOT NULL UNIQUE,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS customers (
	id TEXT PRIMARY KEY,
	tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	key TEXT NOT NULL,
	name TEXT,
	company TEXT,
	stage TEXT,
	notes TEXT,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
	UNIQUE (tenant_id, key)
);

CREATE TABLE IF NOT EXISTS knowledge_documents (
	id TEXT PRIMARY KEY,
	tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	title TEXT NOT NULL,
	source_type TEXT NOT NULL DEFAULT 'text',
	content TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
	id TEXT PRIMARY KEY,
	tenant_id TEXT NOT NULL,
	document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
	chunk_index INTEGER NOT NULL,
	content TEXT NOT NULL
);

-- trigram 分词器:支持中文子串检索(SQLite >=3.34)
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts USING fts5(
	tenant_id UNINDEXED,
	chunk_id UNINDEXED,
	content,
	tokenize = 'trigram'
);

CREATE TRIGGER IF NOT EXISTS knowledge_chunks_ai AFTER INSERT ON knowledge_chunks BEGIN
	INSERT INTO knowledge_chunks_fts (tenant_id, chunk_id, content)
	VALUES (new.tenant_id, new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS knowledge_chunks_ad AFTER DELETE ON knowledge_chunks BEGIN
	INSERT INTO knowledge_chunks_fts (knowledge_chunks_fts, tenant_id, chunk_id, content)
	VALUES ('delete', old.tenant_id, old.id, old.content);
END;

CREATE TABLE IF NOT EXISTS analyses (
	id TEXT PRIMARY KEY,
	tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
	conversation_id TEXT NOT NULL,
	intent TEXT NOT NULL,
	summary TEXT NOT NULL,
	signals_json TEXT NOT NULL DEFAULT '[]',
	suggested_reply TEXT NOT NULL,
	next_steps_json TEXT NOT NULL DEFAULT '[]',
	followup_at TEXT,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_analyses_customer ON analyses (tenant_id, customer_id, created_at DESC);

-- v2:跟进任务(loop F3:分析产出 nextSteps 自动生成任务,到期提醒)
CREATE TABLE IF NOT EXISTS next_step_tasks (
	id TEXT PRIMARY KEY,
	tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
	analysis_id TEXT,
	action TEXT NOT NULL,
	due_at TEXT,
	status TEXT NOT NULL DEFAULT 'pending',
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
	completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON next_step_tasks (tenant_id, status, due_at);
CREATE INDEX IF NOT EXISTS idx_tasks_customer ON next_step_tasks (tenant_id, customer_id, created_at DESC);