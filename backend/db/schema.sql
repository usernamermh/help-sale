-- 业务库 v1:租户 / 客户 / 知识库 / 分析结果
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tenants (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	slug TEXT NOT NULL UNIQUE,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- REFERENCES tenants(id)：外键，指向 tenants 表的 id 字段。意思是这个租户必须真实存在。
-- ON DELETE CASCADE：级联删除。如果 tenants 表里对应的租户被删除了，那么属于这个租户的所有客户记录也会自动一起删除。
-- key 单独不唯一，它是和 tenant_id 组合起来才唯一（见最后的 UNIQUE 约束）
CREATE TABLE IF NOT EXISTS customers (
	id TEXT PRIMARY KEY,
	tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	key TEXT NOT NULL,
	name TEXT,
	company TEXT,
	stage TEXT,
	notes TEXT,
	phone TEXT,
	region TEXT,
	funnel_stage TEXT,
	lost_reason TEXT,
	funnel_stage_changed_at TEXT,
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
-- 一张 SQLite FTS5 全文搜索虚拟表，用来给知识库片段做中文子串检索
-- CREATE VIRTUAL TABLE：创建虚拟表。它本身不直接存普通行数据，而是由 FTS5 这个“扩展模块”来管理，专门为全文检索优化。
-- UNINDEXED：这个字段不参与全文索引，只是原样存着。

-- 普通表存完整业务数据。
-- FTS 表只存搜索需要的字段：租户、原记录 ID、正文。
-- 搜索时先查 FTS 表拿到 chunk_id，再回普通表取完整信息。

-- 示例：
-- SELECT chunk_id
-- FROM knowledge_chunks_fts
-- WHERE knowledge_chunks_fts MATCH '人工智能'
--   AND tenant_id = 'tenant-001';
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts USING fts5(
	tenant_id UNINDEXED,
	chunk_id UNINDEXED,
	content,
	tokenize = 'trigram'
);


-- 一个 SQLite 触发器（Trigger），作用是：每当往 knowledge_chunks 表插入一条新数据时，自动同步往全文索引表 knowledge_chunks_fts 里也插入对应记录。
-- CREATE TRIGGER：创建触发器。触发器是一段“绑在表上的自动代码”，满足条件就自动执行。
-- IF NOT EXISTS：已存在就不重复创建。
-- knowledge_chunks_ai：触发器名字。命名有惯例：
-- knowledge_chunks：绑定的表名。
-- _ai：After Insert 的缩写，表示“插入之后触发”。
-- 类似的还有 _au（after update）、_ad（after delete）。
-- AFTER INSERT ON knowledge_chunks：触发时机和对象——在 knowledge_chunks 表执行 INSERT 之后触发。
-- BEGIN ... END;：触发器要执行的 SQL 语句块。
CREATE TRIGGER IF NOT EXISTS knowledge_chunks_ai AFTER INSERT ON knowledge_chunks BEGIN
	INSERT INTO knowledge_chunks_fts (tenant_id, chunk_id, content)
	VALUES (new.tenant_id, new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS knowledge_chunks_ad AFTER DELETE ON knowledge_chunks BEGIN
	DELETE FROM knowledge_chunks_fts WHERE chunk_id = old.id;
END;


-- v2:跟进任务(loop F3:分析产出 nextSteps 自动生成任务,到期提醒)
CREATE TABLE IF NOT EXISTS next_step_tasks (
	id TEXT PRIMARY KEY,
	tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
	analysis_id TEXT,
	sales_id TEXT REFERENCES sales(id) ON DELETE SET NULL,
	action TEXT NOT NULL,
	due_at TEXT,
	status TEXT NOT NULL DEFAULT 'pending',
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
	completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON next_step_tasks (tenant_id, status, due_at);
CREATE INDEX IF NOT EXISTS idx_tasks_customer ON next_step_tasks (tenant_id, customer_id, created_at DESC);

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
	suggest_action TEXT,
	matched_title TEXT,
	similarity_score REAL,
	old_title TEXT,
	old_content TEXT,
	review_note TEXT,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
	approved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_kc_status ON knowledge_candidates (tenant_id, status, created_at DESC);

-- v6:分析时间线(loop T28:agent 事件序列,供回放与可观测)
CREATE TABLE IF NOT EXISTS agent_events (
	id TEXT PRIMARY KEY,
	tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	conversation_id TEXT NOT NULL,
	thread_id TEXT,
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
	version INTEGER NOT NULL DEFAULT 1,
	-- draft=挖掘待审批 / enabled=已晋升可被模型调用 / disabled=人工停用 / rejected=人工驳回
	status TEXT NOT NULL DEFAULT 'enabled',
	-- 来源:manual=人工或接口预定义 / mined=从模型执行轨迹挖掘
	origin TEXT NOT NULL DEFAULT 'manual',
	-- 工具序列签名(形如 customer_query→knowledge_search),用于挖掘去重
	source_signature TEXT,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_wf_tenant ON workflows (tenant_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_wf_sig ON workflows (tenant_id, source_signature);

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
	discount_amount REAL NOT NULL DEFAULT 0,
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

-- v18:自动任务执行记录(晨报/周报/沉默唤醒等,前端可查看状态)
CREATE TABLE IF NOT EXISTS automation_runs (
	id TEXT PRIMARY KEY,
	tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	job_type TEXT NOT NULL,
	run_date TEXT NOT NULL,
	status TEXT NOT NULL,
	summary TEXT,
	detail_json TEXT,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_ar_tenant ON automation_runs (tenant_id, job_type, run_date DESC);

-- v19:反思案例(话术评估低分/运行失败),供自我改进闭环聚合
CREATE TABLE IF NOT EXISTS reflection_cases (
	id TEXT PRIMARY KEY,
	tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	case_type TEXT NOT NULL,
	ref_id TEXT,
	detail_json TEXT,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_rc_tenant ON reflection_cases (tenant_id, case_type, created_at DESC);

-- v20:会话摘要(中期记忆:thread 长对话压缩落库,超长 history 注入摘要)
CREATE TABLE IF NOT EXISTS thread_summaries (
	id TEXT PRIMARY KEY,
	tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	thread_id TEXT NOT NULL,
	summary TEXT NOT NULL,
	message_seq_until INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
	UNIQUE (tenant_id, thread_id)
);

-- v21:Agent 执行计划(规划-执行-验证循环)
CREATE TABLE IF NOT EXISTS agent_plans (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL,
	tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	thread_id TEXT,
	goal TEXT NOT NULL,
	plan_json TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'planned',
	executed_tools_json TEXT,
	verification_json TEXT,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_ap_run ON agent_plans (tenant_id, run_id);

-- v22:自定义定时任务(弹窗管理:新增/编辑/删除/启停)
CREATE TABLE IF NOT EXISTS automation_jobs (
	id TEXT PRIMARY KEY,
	tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	schedule_type TEXT NOT NULL DEFAULT 'daily',
	interval_days INTEGER,
	weekday INTEGER,
	schedule_time TEXT NOT NULL,
	description TEXT,
	action_json TEXT NOT NULL DEFAULT '{}',
	enabled INTEGER NOT NULL DEFAULT 1,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_aj_tenant ON automation_jobs (tenant_id, enabled, schedule_type);

-- v23:内置任务启停开关(tenant + job_key;无记录=默认启用)
CREATE TABLE IF NOT EXISTS builtin_job_settings (
	id TEXT PRIMARY KEY,
	tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	job_key TEXT NOT NULL,
	enabled INTEGER NOT NULL DEFAULT 1,
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
	UNIQUE (tenant_id, job_key)
);

-- v27:看板卡片(多代理协作通信总线,SQLite 存储替代 JSON 文件)
CREATE TABLE IF NOT EXISTS kanban_cards (
	id TEXT PRIMARY KEY,
	tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	thread_id TEXT NOT NULL,
	title TEXT NOT NULL,
	description TEXT,
	status TEXT NOT NULL DEFAULT 'pending',
	goal TEXT,
	tools_json TEXT,
	result TEXT,
	error TEXT,
	share_enabled INTEGER NOT NULL DEFAULT 0,
	-- v40:领取归属与租约(多实例安全)+ 重试次数
	owner_instance TEXT,
	lease_expires_at TEXT,
	attempts INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_kanban_thread ON kanban_cards (tenant_id, thread_id, status);

-- v30:关键词库(用户可增删改查;free 挖掘入库/strict 匹配回写)
CREATE TABLE IF NOT EXISTS keywords (
	id TEXT PRIMARY KEY,
	tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	keyword TEXT NOT NULL,
	category TEXT,
	category_l1 TEXT,
	category_l2 TEXT,
	category_l3 TEXT,
	source TEXT NOT NULL DEFAULT 'manual',
	hit_count INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
	UNIQUE (tenant_id, keyword)
);
CREATE INDEX IF NOT EXISTS idx_keywords_tenant ON keywords (tenant_id, keyword);

-- v32:独立分类目录树(一级/二级/三级,parent_id 关联,支持增删改)
CREATE TABLE IF NOT EXISTS keyword_categories (
	id TEXT PRIMARY KEY,
	tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	parent_id TEXT REFERENCES keyword_categories(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	level INTEGER NOT NULL DEFAULT 1,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
	UNIQUE (tenant_id, parent_id, name)
);
CREATE INDEX IF NOT EXISTS idx_kc_parent ON keyword_categories (tenant_id, parent_id);

-- v34:工作流(workflows 定义 + workflow_runs 执行记录)
CREATE INDEX IF NOT EXISTS idx_wf_tenant ON workflows (tenant_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_wf_sig ON workflows (tenant_id, source_signature);

CREATE TABLE IF NOT EXISTS workflow_runs (
	id TEXT PRIMARY KEY,
	tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
	status TEXT NOT NULL DEFAULT 'running',
	params_json TEXT,
	result_json TEXT,
	error TEXT,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
	completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_wfr_wf ON workflow_runs (tenant_id, workflow_id, created_at DESC);

-- v35:关键词命中去重明细(keyword_hits)+ 对话已挖掘标记
CREATE TABLE IF NOT EXISTS keyword_hits (
	id TEXT PRIMARY KEY,
	tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	keyword_id TEXT NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
	conversation_id TEXT,
	conversation_date TEXT,
	sales_name TEXT,
	customer_name TEXT,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
	UNIQUE (keyword_id, conversation_id)
);
CREATE INDEX IF NOT EXISTS idx_kh_keyword ON keyword_hits (tenant_id, keyword_id, created_at DESC);

-- v37:知识向量索引(语义检索旁路;向量权威副本在 Milvus,本表用于本地兜底与全量重建)
CREATE TABLE IF NOT EXISTS knowledge_embeddings (
	id TEXT PRIMARY KEY,
	tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	document_id TEXT NOT NULL,
	chunk_id TEXT NOT NULL UNIQUE,
	chunk_index INTEGER NOT NULL,
	dimension INTEGER NOT NULL,
	model TEXT NOT NULL,
	vector_json TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_ke_tenant ON knowledge_embeddings (tenant_id, document_id);
CREATE INDEX IF NOT EXISTS idx_ke_tenant_chunk ON knowledge_embeddings (tenant_id, chunk_id);

-- v38:微信通道(iLink 机器人):登录绑定关系 + 收发审计
CREATE TABLE IF NOT EXISTS weixin_users (
	id TEXT PRIMARY KEY,
	tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	openid TEXT NOT NULL,
	nickname TEXT,
	bound_kind TEXT,
	bound_id TEXT,
	thread_id TEXT,
	last_active_at TEXT,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
	UNIQUE (tenant_id, openid)
);
CREATE INDEX IF NOT EXISTS idx_wxu_tenant ON weixin_users (tenant_id, last_active_at DESC);
CREATE INDEX IF NOT EXISTS idx_wxu_thread ON weixin_users (tenant_id, thread_id);

CREATE TABLE IF NOT EXISTS weixin_messages (
	id TEXT PRIMARY KEY,
	tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	openid TEXT NOT NULL,
	direction TEXT NOT NULL,
	message_id TEXT,
	msg_type TEXT NOT NULL,
	content TEXT NOT NULL,
	thread_id TEXT,
	run_id TEXT,
	status TEXT NOT NULL,
	error TEXT,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_wxm_tenant ON weixin_messages (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wxm_msgid ON weixin_messages (tenant_id, direction, message_id);

-- v39:微信会话目录(一个联系人可以有多个会话,/sessions 与 /switch 用)
CREATE TABLE IF NOT EXISTS weixin_threads (
	id TEXT PRIMARY KEY,
	tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	openid TEXT NOT NULL,
	thread_id TEXT NOT NULL,
	title TEXT,
	last_active_at TEXT,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
	UNIQUE (tenant_id, openid, thread_id)
);
CREATE INDEX IF NOT EXISTS idx_wxt_tenant ON weixin_threads (tenant_id, openid, last_active_at DESC);