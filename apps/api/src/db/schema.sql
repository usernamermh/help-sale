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
	phone TEXT,
	intended_vehicles TEXT,
	region TEXT,
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
	category TEXT,
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
	request_hash TEXT,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_analyses_customer ON analyses (tenant_id, customer_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_analyses_req_hash ON analyses (tenant_id, request_hash) WHERE request_hash IS NOT NULL;

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

-- v3:车型库与优选方案(车型优选)
CREATE TABLE IF NOT EXISTS vehicles (
	id TEXT PRIMARY KEY,
	tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	brand TEXT NOT NULL,
	series TEXT NOT NULL,
	model_name TEXT NOT NULL,
	energy_type TEXT NOT NULL,
	body_type TEXT NOT NULL,
	price_min REAL NOT NULL,
	price_max REAL NOT NULL,
	seats INTEGER NOT NULL,
	positioning TEXT,
	highlights TEXT,
	scenarios TEXT,
	specs_json TEXT NOT NULL DEFAULT '{}',
	UNIQUE (tenant_id, brand, series, model_name)
);
CREATE INDEX IF NOT EXISTS idx_vehicles_price ON vehicles (tenant_id, price_min, price_max);
CREATE INDEX IF NOT EXISTS idx_vehicles_energy_seats ON vehicles (tenant_id, energy_type, seats);

CREATE TABLE IF NOT EXISTS vehicle_match_plans (
	id TEXT PRIMARY KEY,
	tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
	conversation_id TEXT NOT NULL,
	requirement TEXT NOT NULL,
	plan_json TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_vehicle_plans_customer ON vehicle_match_plans (tenant_id, customer_id, created_at DESC);

-- v4:军师晨报(loop F4:每日巡检简报)
CREATE TABLE IF NOT EXISTS digests (
	id TEXT PRIMARY KEY,
	tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	digest_date TEXT NOT NULL,
	title TEXT NOT NULL,
	content TEXT NOT NULL,
	stats_json TEXT NOT NULL DEFAULT '{}',
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
	UNIQUE (tenant_id, digest_date)
);

-- v5:知识沉淀候选(loop F6:分析产出话术候选,一键确认入库)
CREATE TABLE IF NOT EXISTS knowledge_candidates (
	id TEXT PRIMARY KEY,
	tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	analysis_id TEXT NOT NULL,
	intent TEXT NOT NULL,
	draft_title TEXT NOT NULL,
	draft_content TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending',
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
	approved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_kc_status ON knowledge_candidates (tenant_id, status, created_at DESC);

-- v6:分析时间线(loop T28:agent 事件序列,供回放与可观测)
CREATE TABLE IF NOT EXISTS agent_events (
	id TEXT PRIMARY KEY,
	tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	conversation_id TEXT NOT NULL,
	seq INTEGER NOT NULL,
	event_type TEXT NOT NULL,
	tool_name TEXT,
	payload_json TEXT,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_events_conv ON agent_events (tenant_id, conversation_id, seq);

-- v7:客户画像标签(loop zhiji 语义标签:由分析自动聚合)
CREATE TABLE IF NOT EXISTS customer_tags (
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
);
CREATE INDEX IF NOT EXISTS idx_ct_customer ON customer_tags (tenant_id, customer_id, weight DESC);

-- v9:通知发送日志(到期提醒推送记录)
CREATE TABLE IF NOT EXISTS notification_logs (
	id TEXT PRIMARY KEY,
	tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	channel TEXT NOT NULL DEFAULT 'webhook',
	title TEXT NOT NULL,
	content_json TEXT NOT NULL DEFAULT '{}',
	status TEXT NOT NULL DEFAULT 'sent',
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_nl_tenant ON notification_logs (tenant_id, created_at DESC);

-- v10:会话业务元数据(界面列表:时间/ID/销售/客户;对话原文仍在 pi 会话库)
CREATE TABLE IF NOT EXISTS conversations (
	id TEXT PRIMARY KEY,
	tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
	sales_name TEXT NOT NULL DEFAULT '默认销售',
	sales_id TEXT REFERENCES sales(id) ON DELETE SET NULL,
	sales_phone TEXT,
	store_id TEXT REFERENCES stores(id) ON DELETE SET NULL,
	followup_advice TEXT,
	channel TEXT NOT NULL DEFAULT 'chat',
	message_count INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_conv_tenant ON conversations (tenant_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_kd_category ON knowledge_documents (tenant_id, category);
-- v11:Agent 对话线程(可恢复的多轮会话)
CREATE TABLE IF NOT EXISTS agent_threads (
	id TEXT PRIMARY KEY,
	tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	title TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_at_tenant ON agent_threads (tenant_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_thread_messages (
	id TEXT PRIMARY KEY,
	tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
	seq INTEGER NOT NULL,
	role TEXT NOT NULL,
	content_json TEXT NOT NULL DEFAULT '[]',
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_atm_thread ON agent_thread_messages (tenant_id, thread_id, seq);

-- v12:能力开关与工作流(云端编排端配置)
CREATE TABLE IF NOT EXISTS agent_capabilities (
	tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	capability_name TEXT NOT NULL,
	enabled INTEGER NOT NULL DEFAULT 1,
	updated_at TEXT,
	PRIMARY KEY (tenant_id, capability_name)
);

CREATE TABLE IF NOT EXISTS workflows (
	id TEXT PRIMARY KEY,
	tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	description TEXT NOT NULL DEFAULT '',
	steps_json TEXT NOT NULL DEFAULT '[]',
	enabled INTEGER NOT NULL DEFAULT 1,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_wf_tenant ON workflows (tenant_id, updated_at DESC);

-- v13:门店/销售/成交订单/对话原文/工具调用缓存
CREATE TABLE IF NOT EXISTS stores (
	id TEXT PRIMARY KEY,
	tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	address TEXT,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_stores_tenant ON stores (tenant_id, name);

CREATE TABLE IF NOT EXISTS sales (
	id TEXT PRIMARY KEY,
	tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	store_id TEXT REFERENCES stores(id) ON DELETE SET NULL,
	name TEXT NOT NULL,
	phone TEXT,
	role TEXT NOT NULL DEFAULT 'sales',
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_sales_tenant ON sales (tenant_id, store_id, role);

CREATE TABLE IF NOT EXISTS conversation_messages (
	id TEXT PRIMARY KEY,
	tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
	seq INTEGER NOT NULL,
	speaker_role TEXT NOT NULL,
	speaker_name TEXT,
	content TEXT NOT NULL,
	spoken_at TEXT,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_cm_conv ON conversation_messages (tenant_id, conversation_id, seq);

CREATE TABLE IF NOT EXISTS deals (
	id TEXT PRIMARY KEY,
	tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	store_id TEXT REFERENCES stores(id) ON DELETE SET NULL,
	sales_id TEXT REFERENCES sales(id) ON DELETE SET NULL,
	customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
	conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
	amount REAL NOT NULL DEFAULT 0,
	status TEXT NOT NULL DEFAULT 'closed',
	dealed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_deals_tenant ON deals (tenant_id, store_id, dealed_at DESC);

CREATE TABLE IF NOT EXISTS tool_call_cache (
	id TEXT PRIMARY KEY,
	tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	tool_name TEXT NOT NULL,
	cache_key TEXT NOT NULL,
	result_json TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
	last_used_at TEXT,
	UNIQUE (tenant_id, tool_name, cache_key)
);
CREATE INDEX IF NOT EXISTS idx_tcc_tenant ON tool_call_cache (tenant_id, tool_name);