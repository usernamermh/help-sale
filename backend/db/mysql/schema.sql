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
	created_at VARCHAR(40) NOT NULL DEFAULT '',
	updated_at VARCHAR(40) NOT NULL DEFAULT '',
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
	created_at VARCHAR(40) NOT NULL DEFAULT '',
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


CREATE TABLE IF NOT EXISTS next_step_tasks (
	id VARCHAR(64) PRIMARY KEY,
	tenant_id VARCHAR(64) NOT NULL,
	customer_id VARCHAR(64) NOT NULL,
	analysis_id VARCHAR(64),
	action TEXT NOT NULL,
	due_at VARCHAR(40),
	status VARCHAR(16) NOT NULL DEFAULT 'pending',
	created_at VARCHAR(40) NOT NULL DEFAULT '',
	completed_at VARCHAR(40),
	KEY idx_tasks_due (tenant_id, status, due_at),
	KEY idx_tasks_customer (tenant_id, customer_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS digests (
	id VARCHAR(64) PRIMARY KEY,
	tenant_id VARCHAR(64) NOT NULL,
	digest_date VARCHAR(16) NOT NULL,
	title VARCHAR(500) NOT NULL,
	content TEXT NOT NULL,
	stats_json MEDIUMTEXT NOT NULL,
	created_at VARCHAR(40) NOT NULL DEFAULT '',
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
	created_at VARCHAR(40) NOT NULL DEFAULT '',
	approved_at VARCHAR(40),
	KEY idx_kc_status (tenant_id, status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS agent_events (
	id VARCHAR(64) PRIMARY KEY,
	tenant_id VARCHAR(64) NOT NULL,
	conversation_id VARCHAR(64) NOT NULL,
	thread_id VARCHAR(64),
	seq INT NOT NULL,
	event_type VARCHAR(32) NOT NULL,
	tool_name VARCHAR(128),
	payload_json MEDIUMTEXT,
	created_at VARCHAR(40) NOT NULL DEFAULT '',
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
	created_at VARCHAR(40) NOT NULL DEFAULT '',
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
	created_at VARCHAR(40) NOT NULL DEFAULT '',
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
	created_at VARCHAR(40) NOT NULL DEFAULT '',
	updated_at VARCHAR(40) NOT NULL DEFAULT '',
	KEY idx_conv_tenant (tenant_id, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS agent_threads (
	id VARCHAR(64) PRIMARY KEY,
	tenant_id VARCHAR(64) NOT NULL,
	title VARCHAR(500) NOT NULL DEFAULT '',
	created_at VARCHAR(40) NOT NULL DEFAULT '',
	updated_at VARCHAR(40) NOT NULL DEFAULT '',
	KEY idx_at_tenant (tenant_id, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS agent_thread_messages (
	id VARCHAR(64) PRIMARY KEY,
	tenant_id VARCHAR(64) NOT NULL,
	thread_id VARCHAR(64) NOT NULL,
	seq INT NOT NULL,
	role VARCHAR(16) NOT NULL,
	content_json MEDIUMTEXT NOT NULL,
	created_at VARCHAR(40) NOT NULL DEFAULT '',
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
	version INT NOT NULL DEFAULT 1,
	status VARCHAR(16) NOT NULL DEFAULT 'enabled',
	origin VARCHAR(16) NOT NULL DEFAULT 'manual',
	source_signature VARCHAR(500),
	created_at VARCHAR(40) NOT NULL DEFAULT '',
	updated_at VARCHAR(40) NOT NULL DEFAULT '',
	KEY idx_wf_tenant (tenant_id, updated_at),
	KEY idx_wf_sig (tenant_id, source_signature)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS workflow_runs (
	id VARCHAR(64) PRIMARY KEY,
	tenant_id VARCHAR(64) NOT NULL,
	workflow_id VARCHAR(64) NOT NULL,
	status VARCHAR(16) NOT NULL DEFAULT 'running',
	params_json MEDIUMTEXT,
	result_json MEDIUMTEXT,
	error TEXT,
	created_at VARCHAR(40) NOT NULL DEFAULT '',
	completed_at VARCHAR(40),
	KEY idx_wfr_wf (tenant_id, workflow_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS knowledge_embeddings (
	id VARCHAR(64) PRIMARY KEY,
	tenant_id VARCHAR(64) NOT NULL,
	document_id VARCHAR(64) NOT NULL,
	chunk_id VARCHAR(64) NOT NULL,
	chunk_index INT NOT NULL,
	dimension INT NOT NULL,
	model VARCHAR(128) NOT NULL,
	vector_json MEDIUMTEXT NOT NULL,
	created_at VARCHAR(40) NOT NULL DEFAULT '',
	UNIQUE KEY uq_ke_chunk (chunk_id),
	KEY idx_ke_tenant (tenant_id, document_id),
	KEY idx_ke_tenant_chunk (tenant_id, chunk_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS stores (
	id VARCHAR(64) PRIMARY KEY,
	tenant_id VARCHAR(64) NOT NULL,
	name VARCHAR(255) NOT NULL,
	address VARCHAR(500),
	created_at VARCHAR(40) NOT NULL DEFAULT '',
	KEY idx_stores_tenant (tenant_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sales (
	id VARCHAR(64) PRIMARY KEY,
	tenant_id VARCHAR(64) NOT NULL,
	store_id VARCHAR(64),
	name VARCHAR(255) NOT NULL,
	phone VARCHAR(32),
	role VARCHAR(16) NOT NULL DEFAULT 'sales',
	created_at VARCHAR(40) NOT NULL DEFAULT '',
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
	created_at VARCHAR(40) NOT NULL DEFAULT '',
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
	dealed_at VARCHAR(40) NOT NULL DEFAULT '',
	created_at VARCHAR(40) NOT NULL DEFAULT '',
	KEY idx_deals_tenant (tenant_id, store_id, dealed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS tool_call_cache (
	id VARCHAR(64) PRIMARY KEY,
	tenant_id VARCHAR(64) NOT NULL,
	tool_name VARCHAR(128) NOT NULL,
	cache_key VARCHAR(128) NOT NULL,
	result_json MEDIUMTEXT NOT NULL,
	created_at VARCHAR(40) NOT NULL DEFAULT '',
	last_used_at VARCHAR(40),
	UNIQUE KEY uq_tcc (tenant_id, tool_name, cache_key),
	KEY idx_tcc_tenant (tenant_id, tool_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 由 SQLite schema 转换补建(看板/关键字/定时任务/反思/计划/摘要等)
CREATE TABLE IF NOT EXISTS agent_plans (
  id VARCHAR(64) PRIMARY KEY,
	run_id VARCHAR(255) NOT NULL,
	tenant_id VARCHAR(64) NOT NULL,
	thread_id VARCHAR(255),
	goal VARCHAR(255) NOT NULL,
	plan_json MEDIUMTEXT NOT NULL,
	status VARCHAR(255) NOT NULL DEFAULT 'planned',
	executed_tools_json VARCHAR(255),
	verification_json VARCHAR(255),
	created_at VARCHAR(255) NOT NULL DEFAULT '',
	updated_at VARCHAR(255) NOT NULL DEFAULT '',
  KEY idx_ap_run (tenant_id, run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS automation_jobs (
  id VARCHAR(64) PRIMARY KEY,
	tenant_id VARCHAR(64) NOT NULL,
	name VARCHAR(255) NOT NULL,
	schedule_type VARCHAR(255) NOT NULL DEFAULT 'daily',
	interval_days INT,
	weekday INT,
	schedule_time VARCHAR(255) NOT NULL,
	description VARCHAR(255),
  action_json JSON NOT NULL DEFAULT ('{}'),
	enabled INT NOT NULL DEFAULT 1,
	created_at VARCHAR(255) NOT NULL DEFAULT '',
	updated_at VARCHAR(255) NOT NULL DEFAULT '',
  KEY idx_aj_tenant (tenant_id, enabled, schedule_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS automation_runs (
  id VARCHAR(64) PRIMARY KEY,
	tenant_id VARCHAR(64) NOT NULL,
	job_type VARCHAR(255) NOT NULL,
	run_date VARCHAR(255) NOT NULL,
	status VARCHAR(255) NOT NULL,
	summary VARCHAR(255),
	detail_json MEDIUMTEXT,
	created_at VARCHAR(255) NOT NULL DEFAULT '',
  KEY idx_ar_tenant (tenant_id, job_type, run_date DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS builtin_job_settings (
  id VARCHAR(64) PRIMARY KEY,
	tenant_id VARCHAR(64) NOT NULL,
	job_key VARCHAR(255) NOT NULL,
	enabled INT NOT NULL DEFAULT 1,
	updated_at VARCHAR(255) NOT NULL DEFAULT '',
	UNIQUE (tenant_id, job_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS kanban_cards (
  id VARCHAR(64) PRIMARY KEY,
	tenant_id VARCHAR(64) NOT NULL,
	thread_id VARCHAR(255) NOT NULL,
	title VARCHAR(255) NOT NULL,
	description VARCHAR(255),
	status VARCHAR(255) NOT NULL DEFAULT 'pending',
	goal MEDIUMTEXT,
	tools_json MEDIUMTEXT,
	result MEDIUMTEXT,
	error MEDIUMTEXT,
	share_enabled INT NOT NULL DEFAULT 0,
	created_at VARCHAR(255) NOT NULL DEFAULT '',
	updated_at VARCHAR(255) NOT NULL DEFAULT '',
  KEY idx_kanban_thread (tenant_id, thread_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS keyword_categories (
  id VARCHAR(64) PRIMARY KEY,
	tenant_id VARCHAR(64) NOT NULL,
	parent_id VARCHAR(64),
	name VARCHAR(255) NOT NULL,
	level INT NOT NULL DEFAULT 1,
	created_at VARCHAR(255) NOT NULL DEFAULT '',
	updated_at VARCHAR(255) NOT NULL DEFAULT '',
	UNIQUE (tenant_id, parent_id, name),
  KEY idx_kc_parent (tenant_id, parent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS keyword_hits (
  id VARCHAR(64) PRIMARY KEY,
	tenant_id VARCHAR(64) NOT NULL,
	keyword_id VARCHAR(64) NOT NULL,
	conversation_id VARCHAR(255),
	conversation_date VARCHAR(255),
	sales_name VARCHAR(255),
	customer_name VARCHAR(255),
	created_at VARCHAR(255) NOT NULL DEFAULT '',
	UNIQUE (keyword_id, conversation_id),
  KEY idx_kh_keyword (tenant_id, keyword_id, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS keywords (
  id VARCHAR(64) PRIMARY KEY,
	tenant_id VARCHAR(64) NOT NULL,
	keyword VARCHAR(255) NOT NULL,
	category VARCHAR(255),
	category_l1 VARCHAR(255),
	category_l2 VARCHAR(255),
	category_l3 VARCHAR(255),
	source VARCHAR(255) NOT NULL DEFAULT 'manual',
	hit_count INT NOT NULL DEFAULT 0,
	created_at VARCHAR(255) NOT NULL DEFAULT '',
	updated_at VARCHAR(255) NOT NULL DEFAULT '',
	UNIQUE (tenant_id, keyword),
  KEY idx_keywords_tenant (tenant_id, keyword)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS reflection_cases (
  id VARCHAR(64) PRIMARY KEY,
	tenant_id VARCHAR(64) NOT NULL,
	case_type VARCHAR(255) NOT NULL,
	ref_id VARCHAR(255),
	detail_json VARCHAR(255),
	created_at VARCHAR(255) NOT NULL DEFAULT '',
  KEY idx_rc_tenant (tenant_id, case_type, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS thread_summaries (
  id VARCHAR(64) PRIMARY KEY,
	tenant_id VARCHAR(64) NOT NULL,
	thread_id VARCHAR(255) NOT NULL,
	summary VARCHAR(255) NOT NULL,
	message_seq_until INT NOT NULL DEFAULT 0,
	created_at VARCHAR(255) NOT NULL DEFAULT '',
	updated_at VARCHAR(255) NOT NULL DEFAULT '',
	UNIQUE (tenant_id, thread_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
