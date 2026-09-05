-- MySQL 业务库 schema(与 db/schema.sql 对齐,data.mode=mysql 时使用)
-- 注意:时间戳统一存 ISO 文本(与本地 SQLite 行为一致),id 均为 VARCHAR(36) UUID
CREATE TABLE IF NOT EXISTS tenants (
	id VARCHAR(64) PRIMARY KEY,
	name VARCHAR(255) NOT NULL,
	slug VARCHAR(255) NOT NULL UNIQUE,
	created_at VARCHAR(40) NOT NULL DEFAULT ''
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS customers (
	id VARCHAR(64) PRIMARY KEY,
	tenant_id VARCHAR(64) NOT NULL,
	`key` VARCHAR(255) NOT NULL,
	name VARCHAR(255),
	company VARCHAR(255),
	stage VARCHAR(64),
	notes TEXT,
	phone VARCHAR(32),
	created_at VARCHAR(40) NOT NULL DEFAULT '' DEFAULT '',
	updated_at VARCHAR(40) NOT NULL DEFAULT '' DEFAULT '',
	UNIQUE KEY uq_customers_tenant_key (tenant_id, `key`),
	KEY idx_customers_tenant (tenant_id, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS knowledge_documents (
	id VARCHAR(64) PRIMARY KEY,
	tenant_id VARCHAR(64) NOT NULL,
	title VARCHAR(500) NOT NULL,
	source_type VARCHAR(32) NOT NULL DEFAULT 'text',
	content MEDIUMTEXT NOT NULL,
	category VARCHAR(128),
	created_at VARCHAR(40) NOT NULL DEFAULT '' DEFAULT '',
	KEY idx_kd_category (tenant_id, category)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS knowledge_chunks (
	id VARCHAR(64) PRIMARY KEY,
	tenant_id VARCHAR(64) NOT NULL,
	document_id VARCHAR(64) NOT NULL,
	chunk_index INT NOT NULL,
	content MEDIUMTEXT NOT NULL,
	KEY idx_kc_doc (tenant_id, document_id),
	FULLTEXT KEY ft_kc_content (content) WITH PARSER ngram
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS analyses (
	id VARCHAR(64) PRIMARY KEY,
	tenant_id VARCHAR(64) NOT NULL,
	customer_id VARCHAR(64) NOT NULL,
	conversation_id VARCHAR(64) NOT NULL,
	intent VARCHAR(128) NOT NULL,
	summary TEXT NOT NULL,
	signals_json MEDIUMTEXT NOT NULL,
	suggested_reply TEXT NOT NULL,
	next_steps_json MEDIUMTEXT NOT NULL,
	followup_at VARCHAR(40),
	request_hash VARCHAR(128),
	created_at VARCHAR(40) NOT NULL DEFAULT '' DEFAULT '',
	KEY idx_analyses_customer (tenant_id, customer_id, created_at),
	UNIQUE KEY uq_analyses_req_hash (tenant_id, request_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS next_step_tasks (
	id VARCHAR(64) PRIMARY KEY,
	tenant_id VARCHAR(64) NOT NULL,
	customer_id VARCHAR(64) NOT NULL,
	analysis_id VARCHAR(64),
	action TEXT NOT NULL,
	due_at VARCHAR(40),
	status VARCHAR(16) NOT NULL DEFAULT 'pending',
	created_at VARCHAR(40) NOT NULL DEFAULT '' DEFAULT '',
	completed_at VARCHAR(40),
	KEY idx_tasks_due (tenant_id, status, due_at),
	KEY idx_tasks_customer (tenant_id, customer_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS vehicles (
	id VARCHAR(64) PRIMARY KEY,
	tenant_id VARCHAR(64) NOT NULL,
	brand VARCHAR(64) NOT NULL,
	series VARCHAR(128) NOT NULL,
	model_name VARCHAR(255) NOT NULL,
	energy_type VARCHAR(32) NOT NULL,
	body_type VARCHAR(32) NOT NULL,
	price_min DOUBLE NOT NULL,
	price_max DOUBLE NOT NULL,
	seats INT NOT NULL,
	positioning VARCHAR(255),
	highlights TEXT,
	scenarios TEXT,
	specs_json MEDIUMTEXT NOT NULL,
	UNIQUE KEY uq_vehicles (tenant_id, brand, series, model_name),
	KEY idx_vehicles_price (tenant_id, price_min, price_max),
	KEY idx_vehicles_energy (tenant_id, energy_type, seats)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS vehicle_match_plans (
	id VARCHAR(64) PRIMARY KEY,
	tenant_id VARCHAR(64) NOT NULL,
	customer_id VARCHAR(64) NOT NULL,
	conversation_id VARCHAR(64) NOT NULL,
	requirement TEXT NOT NULL,
	plan_json MEDIUMTEXT NOT NULL,
	created_at VARCHAR(40) NOT NULL DEFAULT '' DEFAULT '',
	KEY idx_vehicle_plans_customer (tenant_id, customer_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS digests (
	id VARCHAR(64) PRIMARY KEY,
	tenant_id VARCHAR(64) NOT NULL,
	digest_date VARCHAR(16) NOT NULL,
	title VARCHAR(500) NOT NULL,
	content TEXT NOT NULL,
	stats_json MEDIUMTEXT NOT NULL,
	created_at VARCHAR(40) NOT NULL DEFAULT '' DEFAULT '',
	UNIQUE KEY uq_digests_date (tenant_id, digest_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS knowledge_candidates (
	id VARCHAR(64) PRIMARY KEY,
	tenant_id VARCHAR(64) NOT NULL,
	analysis_id VARCHAR(64) NOT NULL,
	intent VARCHAR(128) NOT NULL,
	draft_title VARCHAR(500) NOT NULL,
	draft_content TEXT NOT NULL,
	status VARCHAR(16) NOT NULL DEFAULT 'pending',
	created_at VARCHAR(40) NOT NULL DEFAULT '' DEFAULT '',
	approved_at VARCHAR(40),
	KEY idx_kc_status (tenant_id, status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS agent_events (
	id VARCHAR(64) PRIMARY KEY,
	tenant_id VARCHAR(64) NOT NULL,
	conversation_id VARCHAR(64) NOT NULL,
	seq INT NOT NULL,
	event_type VARCHAR(32) NOT NULL,
	tool_name VARCHAR(128),
	payload_json MEDIUMTEXT,
	created_at VARCHAR(40) NOT NULL DEFAULT '' DEFAULT '',
	KEY idx_agent_events_conv (tenant_id, conversation_id, seq)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS customer_tags (
	id VARCHAR(64) PRIMARY KEY,
	tenant_id VARCHAR(64) NOT NULL,
	customer_id VARCHAR(64) NOT NULL,
	tag VARCHAR(128) NOT NULL,
	kind VARCHAR(16) NOT NULL DEFAULT 'auto',
	source VARCHAR(255),
	weight INT NOT NULL DEFAULT 1,
	created_at VARCHAR(40) NOT NULL DEFAULT '' DEFAULT '',
	updated_at VARCHAR(40),
	UNIQUE KEY uq_ct (tenant_id, customer_id, tag),
	KEY idx_ct_customer (tenant_id, customer_id, weight)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS notification_logs (
	id VARCHAR(64) PRIMARY KEY,
	tenant_id VARCHAR(64) NOT NULL,
	channel VARCHAR(32) NOT NULL DEFAULT 'webhook',
	title VARCHAR(500) NOT NULL,
	content_json MEDIUMTEXT NOT NULL,
	status VARCHAR(16) NOT NULL DEFAULT 'sent',
	created_at VARCHAR(40) NOT NULL DEFAULT '' DEFAULT '',
	KEY idx_nl_tenant (tenant_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS conversations (
	id VARCHAR(64) PRIMARY KEY,
	tenant_id VARCHAR(64) NOT NULL,
	customer_id VARCHAR(64),
	sales_name VARCHAR(255) NOT NULL DEFAULT '默认销售',
	sales_id VARCHAR(64),
	sales_phone VARCHAR(32),
	store_id VARCHAR(64),
	followup_advice TEXT,
	channel VARCHAR(32) NOT NULL DEFAULT 'chat',
	message_count INT NOT NULL DEFAULT 0,
	created_at VARCHAR(40) NOT NULL DEFAULT '' DEFAULT '',
	updated_at VARCHAR(40) NOT NULL DEFAULT '' DEFAULT '',
	KEY idx_conv_tenant (tenant_id, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS agent_threads (
	id VARCHAR(64) PRIMARY KEY,
	tenant_id VARCHAR(64) NOT NULL,
	title VARCHAR(500) NOT NULL DEFAULT '',
	created_at VARCHAR(40) NOT NULL DEFAULT '' DEFAULT '',
	updated_at VARCHAR(40) NOT NULL DEFAULT '' DEFAULT '',
	KEY idx_at_tenant (tenant_id, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS agent_thread_messages (
	id VARCHAR(64) PRIMARY KEY,
	tenant_id VARCHAR(64) NOT NULL,
	thread_id VARCHAR(64) NOT NULL,
	seq INT NOT NULL,
	role VARCHAR(16) NOT NULL,
	content_json MEDIUMTEXT NOT NULL,
	created_at VARCHAR(40) NOT NULL DEFAULT '' DEFAULT '',
	KEY idx_atm_thread (tenant_id, thread_id, seq)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS agent_capabilities (
	tenant_id VARCHAR(64) NOT NULL,
	capability_name VARCHAR(128) NOT NULL,
	enabled TINYINT(1) NOT NULL DEFAULT 1,
	updated_at VARCHAR(40),
	PRIMARY KEY (tenant_id, capability_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS workflows (
	id VARCHAR(64) PRIMARY KEY,
	tenant_id VARCHAR(64) NOT NULL,
	name VARCHAR(255) NOT NULL,
	description VARCHAR(500) NOT NULL DEFAULT '',
	steps_json MEDIUMTEXT NOT NULL,
	enabled TINYINT(1) NOT NULL DEFAULT 1,
	created_at VARCHAR(40) NOT NULL DEFAULT '' DEFAULT '',
	updated_at VARCHAR(40) NOT NULL DEFAULT '' DEFAULT '',
	KEY idx_wf_tenant (tenant_id, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS stores (
	id VARCHAR(64) PRIMARY KEY,
	tenant_id VARCHAR(64) NOT NULL,
	name VARCHAR(255) NOT NULL,
	address VARCHAR(500),
	created_at VARCHAR(40) NOT NULL DEFAULT '' DEFAULT '',
	KEY idx_stores_tenant (tenant_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sales (
	id VARCHAR(64) PRIMARY KEY,
	tenant_id VARCHAR(64) NOT NULL,
	store_id VARCHAR(64),
	name VARCHAR(255) NOT NULL,
	phone VARCHAR(32),
	role VARCHAR(16) NOT NULL DEFAULT 'sales',
	created_at VARCHAR(40) NOT NULL DEFAULT '' DEFAULT '',
	KEY idx_sales_tenant (tenant_id, store_id, role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS conversation_messages (
	id VARCHAR(64) PRIMARY KEY,
	tenant_id VARCHAR(64) NOT NULL,
	conversation_id VARCHAR(64) NOT NULL,
	seq INT NOT NULL,
	speaker_role VARCHAR(16) NOT NULL,
	speaker_name VARCHAR(255),
	content TEXT NOT NULL,
	spoken_at VARCHAR(40),
	created_at VARCHAR(40) NOT NULL DEFAULT '' DEFAULT '',
	KEY idx_cm_conv (tenant_id, conversation_id, seq)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS deals (
	id VARCHAR(64) PRIMARY KEY,
	tenant_id VARCHAR(64) NOT NULL,
	store_id VARCHAR(64),
	sales_id VARCHAR(64),
	customer_id VARCHAR(64),
	conversation_id VARCHAR(64),
	amount DOUBLE NOT NULL DEFAULT 0,
	status VARCHAR(16) NOT NULL DEFAULT 'closed',
	dealed_at VARCHAR(40) NOT NULL DEFAULT '' DEFAULT '',
	created_at VARCHAR(40) NOT NULL DEFAULT '' DEFAULT '',
	KEY idx_deals_tenant (tenant_id, store_id, dealed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS tool_call_cache (
	id VARCHAR(64) PRIMARY KEY,
	tenant_id VARCHAR(64) NOT NULL,
	tool_name VARCHAR(128) NOT NULL,
	cache_key VARCHAR(128) NOT NULL,
	result_json MEDIUMTEXT NOT NULL,
	created_at VARCHAR(40) NOT NULL DEFAULT '' DEFAULT '',
	last_used_at VARCHAR(40),
	UNIQUE KEY uq_tcc (tenant_id, tool_name, cache_key),
	KEY idx_tcc_tenant (tenant_id, tool_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;