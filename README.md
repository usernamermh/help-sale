# 助销agent管理平台
![CI](https://img.shields.io/github/actions/workflow/status/usernamermh/help-sale/ci.yml?branch=main&label=CI)
![License](https://img.shields.io/github/license/usernamermh/help-sale)
![Stars](https://img.shields.io/github/stars/usernamermh/help-sale)
![Language](https://img.shields.io/github/languages/top/usernamermh/help-sale)

面向销售团队的助销agent管理平台，以客户会话记录为基础，自动检索团队话术库、识别意向与风险、给出可复制的应对话术与跟进建议，并形成自动闭环。

# 界面截图

### 简单查询
基础的会话/客户/车型查询能力，结果以表格呈现并支持翻页。

![简单查询](docs/images/简单查询.jpg)

### 对话原文抽取
按抽取标准从对话中保真定位并高亮命中片段。

![对话原文抽取](docs/images/对话原文抽取.jpg)

### 标准话术检测
把销售发言与标准话术做原文/语义双通道匹配，输出命中明细与覆盖率。

![标准话术检测](docs/images/标准话术检测.jpg)

### 关键词管理
三级分类目录 + 勾选筛选 + 关键词增删改查。

![关键词管理](docs/images/关键词管理.jpg)

### 绘图和表格
模型直接生成图表，表格由前端控件原样渲染。

![绘图和表格](docs/images/绘图和表格.jpg)

### 定时任务
定时任务管理：内置任务与自定义任务，可查看执行记录与结果。

![定时任务](docs/images/定时任务.jpg)

### 晨报
每日晨报与经营趋势：待办/到期任务、分析量、意图分布、车型偏好。

![晨报](docs/images/晨报.jpg)

### multi agent 模式
多代理并行分析：主代理拆分任务，子代理并行执行，看板协作。

![multi agent模式](docs/images/multi_agent模式.jpg)
# 技术栈

- Node.js >= 24(`node:sqlite`) + TypeScript + Fastify + Vitest
- [pi(0.84.1, earendil-works)](https://github.com/earendil-works/pi)agent 运行时的本地 workspace 构建
- SQLite:FTS5 trigram 中文检索、多租户隔离、分析落库
- 模型，OpenAI 兼容端点(配置驱动);测试用 pi 内置 faux 模型做离线端到端

# 配置

所有运行时配置集中在仓库顶层 **[help-sale.config.yaml](help-sale.config.yaml)**，YAML 格式，**支持 # 注释**，每个字段都写明了作用;覆盖，服务监听、数据目录、默认租户、模型端点/模型名/密钥/代理/上下文窗口(含 `model.extraBody` —— 额外模型参数会统一放进请求体 `extra_body` 字段，不与标准参数平级)、知识分块参数、检索条数、公司与团队名称。

配置只从该文件读取，不支持环境变量覆盖;唯一例外是 `CONFIG_PATH` 用于指定其他配置文件路径。

# 快速开始

```bash
npm ci --prefix pi --ignore-scripts
node scripts/gen-minimal-model-data.mjs        # 离线模型数据(models.dev 不可达时)
npm run build:offline --prefix pi
npm install --ignore-scripts                    # 根 workspace 链接 pi 包
npm test                                        # 253 tests
npm run typecheck
```

开发服务，

```bash
npm run dev                                     # 监听 help-sale.config.yaml 中的 host:port
```

# 中间件(可选)

- **MySQL**(连接信息在 help-sale.config.yaml mysql 段，按部署环境填入凭据):分析(analyses)与车型优选方案(vehicle_match_plans)自动归档，失败自动降级不影响主流程;可用于后续报表/BI。
- **Redis**(连接信息在 help-sale.config.yaml redis 段，按部署环境填入凭据):跟进任务到期提醒队列，前端可查询已到期待办并显示「已到期」标记，完成即出队。
- 连接信息与开关都在 help-sale.config.yaml(mysql/redis 段),按部署环境填入凭据;`enabled: false` 关闭(Redis 自动退化为内存队列)。

# 记忆架构

平台采用三层记忆：短期（当前轮次+最近消息）、中期（会话摘要）、长期（memory.md + 知识库 + 客户档案）。

- 三层记忆
  - 短期：当前轮次 + 最近消息原文，随请求传递
  - 中期：会话摘要（thread_summaries 表），会话超 30 条时压缩早期内容
  - 长期：memory.md（偏好/经验）+ 知识库 + 客户档案，每次构建系统提示词时读取

- memory.md（长期记忆核心）
  - 文件位置：配置 memoryFile（默认 apps/api/data/memory.md）
  - 五个小节：用户记忆 / 系统记忆 / 工具经验 / 规则改进 / 模型端点
  - 生效方式：构建 Agent 系统提示词时 loadMemoryText 读取 memory.md，拼进【系统记忆】段，模型每轮可见
  - 设计边界：只存偏好与经验，业务数据（客户/会话/订单）一律走数据库

- update_memory 工具（写入入口）
  - 参数：section + content（单条 ≤ 2000 字符）
  - 校验小节：normalizeSection 检查是否命中白名单，否则抛错
  - 幂等去重：相同内容行不重复追加
  - 定位小节标题后插入，写回文件
  - 触发时机（模型主动）
    - 用户表达偏好（如「报告都用表格」）→ 写入用户记忆
    - 确认工具技巧有效 → 写入工具经验
    - 确认模型端点行为 → 写入模型端点
    - 反思任务提炼规则 → 写入规则改进

- 会话摘要（中期记忆）
  - 每次会话运行结束用规则算法生成摘要（前 8 个用户目标 + 最近 3 条结论），存 thread_summaries 表，不依赖模型
  - 历史消息超过 30 条时，compressHistory 把早期内容压缩为【历史摘要】注入对话，保留最近 30 条原文
  - 导出会话 JSON 时附带摘要

- 反思闭环（自动写入长期记忆）
  - 采集：话术评估低分（<70）与 Agent 运行失败自动进入 reflection_cases
  - 聚合：每周一 09:30「反思改进」定时任务汇总近 7 天案例（按主题聚类、统计次数）
  - 写入：applyReflectionToMemory 把建议写入 memory.md「规则改进」小节（去重、限量）
  - 手动入口：POST /api/v1/reflections/apply，前端「反思改进」卡片可手动触发同样逻辑

## 工具实现

### 业务级工具

#### 客户与查询
- **conversation_query**：会话列表/对话原文（翻页）
- **customer_query**：客户清单/档案/历史/标签（支持按姓名解析真实客户）
- **vehicle_query**：车型检索（预算/座位/能源/级别/关键词）

#### 话术与质检

- **knowledge_search**：话术/知识库检索（FTS5 中文检索）
  核心链路：数据入库 → 检索入口 → 检索策略。
  - 数据入库（前置环节，决定检索质量）
    知识不是直接整篇存进去的，入库时先分块：
    - knowledge_ingest 把话术/政策/竞品资料交给 chunker.splitText 按段落切分（默认 600 字符/块、80 字符重叠，配置在 yaml chunker 段）
    - 每个块写入 knowledge_chunks 表（带 tenant_id 租户隔离、document_id 归属、chunk_index 顺序）
    - SQLite FTS5 触发器自动同步到全文索引 knowledge_chunks_fts——用 trigram 分词器
    trigram 是 SQLite FTS5 提供的分词方式：把文本按每 3 个连续字符切成子串建索引，检索时同样切查询词匹配子串。
    比如「汉EV冠军版」切成：汉EV → EV冠 → V冠军 → 冠军版；搜「冠军版」时查询也切成 冠军版，直接命中。
    不需要中文分词、不依赖词库，对品牌名、话术短语这类中文关键词特别友好。
  - 检索入口（工具层）
    - 先走 withToolCache：按「工具名 + 租户 + 参数」算哈希查 tool_call_cache，相同查询直接返回缓存结果
    - 未命中则调用 searchKnowledge 真正检索
  - 检索策略（仓库层，双通道 + 回退）
    - 长词（≥3 字符）→ FTS5 全文检索：MATCH + snippet() 生成带高亮标记的摘要，按 rank 排序（主通道）
    - 短词（<3 字符）→ LIKE 模糊匹配（trigram 对过短词效果差，直接 content LIKE '%词%'）
    - 全部无命中 → 整句 LIKE 回退：把整个清洗后的查询做一次 LIKE 兜底
    多词查询时对每个词分别检索，结果按 chunk 去重合并，再截断到 limit（默认 yaml knowledge.searchLimit）。

- **knowledge_ingest** / **knowledge_candidate**：话术沉淀（批量入库、自动分块去重）
  整体链路：触发来源 → 生成候选 → 后台二次确认 → 审批 → 入库。
  - 触发来源
    - 主 agent 主动发现（任务中觉得值得沉淀），调用 knowledge_ingest(entries=[{title, content}, ...], category)
    - 会话分析自动生成（分析后建议回复 → 自动候选）
    - HTTP 上传（前端/外部导入，/api/v1/knowledge[/batch]）
    - 三条路都进入「候选 → 二次确认 → 审批」链路
  - 生成沉淀候选（createCandidate）
    - 写入 knowledge_candidates 表：draft_title / draft_content（标题与内容）、intent / analysis_id（分类与来源）、status='pending'（待确认）
    - 返回候选 ID → 前端/模型可见「待确认」条目
  - 后台二次确认（reviewCandidate）
    - 检索相关文档：用「标题 + 内容前200字」调 knowledge_search（FTS5 trigram 长词 / LIKE 短词回退），取前 5 条命中文档
    - 语义相似度对比：候选内容与命中文档分块做 embedding，逐块余弦相似度取最高分，记录 matched_title / similarity_score
    - 建议规则（写回候选）
      - 无命中 或 相似度 < 0.45 → suggest_action = add（知识库无相似内容，建议新增）
      - 0.45 ≤ 相似度 < 0.9 → suggest_action = update（内容有差异，建议覆盖；快照 old_title / old_content 留存旧版本）
      - 相似度 ≥ 0.9 → suggest_action = skip（内容基本一致，建议跳过）
      - 每条候选带 review_note（可解释的判断说明）
  - 审批（knowledge_candidate）
    - op = list：列出 pending 候选（含建议动作）
    - op = approve：按建议执行
      - 建议 add → 正常入库
      - 建议 update → 覆盖旧版本：deleteKnowledgeDocumentByTitle 删旧文档（删 knowledge_chunks 触发清 FTS 索引、删 knowledge_documents），再写入新内容
      - 建议 skip → 不落库，直接标记 approved
      - 候选 → status = approved，记录 approved_at
    - op = reject：标记 rejected（不落库）
  - 入库（ingestDocument，新增/覆盖共用）
    - 分块（splitText）：默认 600 字符/块、80 字符重叠（yaml chunker 段）；按空行分段落，不超 size 就合并；超长段落按 600 硬切；下一段从 size - overlap（520 字符）开始，上下文不丢
    - 写 knowledge_documents：租户 / 标题 / 分类 / 整篇内容拼接（tenant_id 隔离）
    - 写 knowledge_chunks：每块一行（租户 / 文档ID / chunk_index / 内容），事务批量插入
    - FTS 索引同步（触发器）：AFTER INSERT 自动写 knowledge_chunks_fts，AFTER DELETE 自动删索引行——入库即索引，knowledge_search 立即可检索

- **playbook_check**：话术命中检测（原文+语义双通道，默认匹配全部类别）
  输入：销售姓名/ID + 时间范围 + 可选分类。
  - 取话术库：查 knowledge_chunks（关联 documents），默认匹配全部类别，传 category 才按分类过滤；每条话术做清洗（cleanText）+ embedding 向量
  - 取待检对话：按销售姓名/ID 找最近 N 条会话，只取 speaker_role = 'sales' 的发言，逐句清洗
  - 双通道匹配（每条销售发言 vs 每条话术）
    - 原文命中：归一化后句子包含话术原文（话术长度≥4）→ 命中方式 exact，相似度 1
    - 语义命中：销售发言 embedding vs 话术 embedding，余弦 top-1 ≥ 阈值（默认 0.72）→ 命中方式 semantic
  - 聚合统计：检查会话/句子数、命中句数（原文/语义各多少）、覆盖话术数 + 覆盖率
  - 返回：摘要 + 命中明细表格（日期/客户/销售/命中话术/方式/相似度，rawTable 前端原样渲染）

#### 任务与销售流程

- **task_manage**：跟进任务（创建/列表/完成，到期提醒）
  任务来源（四个）：
  - 主 agent 主动创建（op=create，销售/模型发现下一步动作）
  - 会话分析自动创建（分析出「建议下一步」→ 自动建首条任务）
  - 试驾完成自动生成（24h/3天/7天三段回访）
  - 成交后自动生成（3天提车关怀 / 30天保养邀约）
  - 处理流程：
    - 创建（op=create）
      - 输入：customerKey（或姓名）+ action + dueAt（可选）
      - 客户解析：姓名 → 真实客户 key（杜绝幽灵客户）
      - 落库：next_step_tasks（tenant/customer/action/due_at/status=pending）
      - 入提醒队列：Redis ZSET 或内存 Map
    - 自动来源细节
      - 试驾完成（complete）：24h 确认试驾感受与疑虑；3d 推进报价/方案、问竞品；7d 促成到店/成交或长线培育
      - 成交（closed）：3d 提车关怀（确认用车体验、收集满意度）；30d 保养邀约、老带新转介绍
    - 到期提醒（自动）：定时取到期任务（Redis ZRANGEBYSCORE 0~now / 内存遍历），GET /api/v1/reminders/overdue 前端显示「已到期」，可选 Webhook 通知（notification_logs 留痕）
    - 查询（op=list）：按状态过滤（pending/done），关联客户名，按 due_at 升序（紧急在前），返回文本列表给模型/前端
    - 完成（op=complete）：状态 → done + 记录 completed_at，从提醒队列移除（防止已完成再提醒）

- **test_drive_manage**：试驾管理（登记/完成/取消，自动生成 24h/3天/7天回访）
  状态机：scheduled（已登记）→ completed（已完成）/ cancelled（已取消）。
  - 登记（op=create）
    - 输入：customerKey（或姓名）+ 可选 salesId/storeId/vehicleId/scheduledAt
    - 客户解析：姓名 → 真实客户 key（resolveCustomerByKeyOrName）
    - 落库：test_drives 表，status = scheduled
    - 漏斗联动：setFunnelStage（客户 → test_drive 试驾阶段）
    - 返回试驾记录（含预约时间）
  - 完成（op=complete）
    - 输入：testDriveId + 可选 feedback（试驾反馈）/ competitorCompared（对比竞品）
    - 更新：status = completed + 记录反馈
    - 自动生成三段回访（scheduleTestDriveFollowups），以试驾时间为基准（scheduled_at 或 updated_at）
      - +24h：试驾后回访，确认试驾感受与疑虑
      - +3天：试驾后回访，推进报价/方案，询问竞品对比
      - +7天：试驾后回访，促成到店/成交，或转长线培育
      - 逐条 createTask → next_step_tasks + 到期提醒队列
  - 取消（op=cancel）：输入 testDriveId，status = cancelled，不生成回访任务
  - 查询（op=list）：可选过滤 storeId / status / limit，关联客户名 + 车型名（LEFT JOIN），按预约时间排序

#### 经营洞察

- **insight_query**：每日晨报/经营趋势（分析量、意图、任务完成率、车型偏好）
  - 每日晨报（type=morning，默认）
    - collectDigest（租户，当前时间）统计内容：
      - 进行中跟进任务数 + 已到期数（按 due_at ≤ now 判断）
      - 最近 24 小时新增分析数
      - 近 7 天车型优选方案数
      - 客户总数
      - 近 7 天热门意图分布（价格异议/需求确认… top5）
      - 优先跟进清单（待办按到期时间排序，取前 8，标 ⚠️ 已到期）
    - formatDigest 拼成 Markdown 晨报：助销晨报·日期 / 关键数字 / 优先跟进 / 意图分布 / 今日建议
    - 返回文本 + 结构化 stats（前端可单独渲染）
  - 经营趋势（type=trend，近 N 天，默认 7）
    - collectInsights（days，上限 90）统计内容：
      - 分析量（总数 + 按天分布 analysesByDay）
      - 热门意图 top6
      - 待办/到期任务数 + 任务完成率（done/(pending+done)）
      - 车型优选方案数
      - 热门品牌 top3（解析近 50 条方案 JSON 里的推荐品牌）
    - 返回摘要文本 + 结构化 Insights

### 系统级工具

#### 多代理协作
- **subagents**：子代理任务（并行执行、看板通信、禁止再派生）
- **kanban**：子agent协作看板（SQLite 存储，按会话隔离）

#### 文件与数据
- **file_read** / **file_write_new**：任意路径读文件 / 只写新文件
- **txt** / **excel** / **ppt**：仓库内文本/Excel/PPT 读取
- **sql**：业务库操作（默认只读，危险语句拦截+审计）
- **redis**：Redis 白名单操作

#### 算法与呈现
- **embedding** / **similarity** / **cluster**：文本向量、语义相似度、聚类
- **keyword_extract_free** / **keyword_extract_strict**：标签抽取/匹配
  - keyword_extract_free（自由挖掘）：参考词库前 N 个 → LLM 挖掘 → 自动去重入库（支持「名称(一级/二级/三级)」格式解析）
  - keyword_extract_strict（严格匹配）：长对话按窗口切片 → 切片与词库做相似度预筛（多候选全量匹配 ≥ 阈值）→ LLM 抽取 → 校验在候选内 → 回写词库（保留分类）
- **dialog_extract**：对话原文抽取（按标准保真抽取片段）
  - 读完整对话：listConversationMessages（租户，会话ID）按 seq 排序
  - 编号 1..N（与 seq 对齐），每句转成「序号. [客户/销售] 内容」
  - 调用大模型抽序号：独立 Agent + 系统模型，提示词给出编号对话 + 抽取标准，约束只输出 ```json 序号数组（如 [1,3,7]），禁止转述原文
  - 校验与取原文：越界序号丢弃，按序号从原始 rows 取 content（原样），组装命中消息（seq/role/speakerName/content/spokenAt）
  - 返回：content（命中句列表文本）+ details（conversationId / standard / hitIndexes / messages），前端对话原文卡片对命中句加粗
- **table_generate** / **chart_generate**：表格/流程图/统计图（结果由前端直接渲染）
- **computer** / **date_tool** / **browser**：计算、日期转换、HTTP 抓取
- **update_memory**：系统记忆更新（memory.md）
  - 输入：小节（section）+ 内容（content）
    - section 白名单：用户记忆 / 系统记忆 / 工具经验 / 规则改进 / 模型端点
    - content 限制：单条 ≤ 2000 字符
  - 校验小节：normalizeSection——section 包含白名单任一项才通过，否则抛错
  - 读取 memory.md（不存在则用模板，模板含 5 个固定小节标题；文件路径来自配置 memoryFile，默认 apps/api/data/memory.md）
  - 幂等去重：内容清洗（压缩空白 → 拼成「- 内容」一行），若该行已存在则直接返回，不重复追加
  - 定位小节并插入：找到「## 目标小节」标记，在标题行后插入新行，写回文件
  - 生效方式：下次构建系统提示词时生效——getSalesAgentSystemPrompt → loadMemoryText 读取 memory.md → 拼进【系统记忆】段
  - 触发路径
    - 模型主动调用：发现用户偏好（如「报告都用表格」→ 用户记忆）、沉淀工具经验、记录模型端点、反思规则改进
    - 反思闭环自动触发：每周一 09:30「反思改进」定时任务聚合 reflection_cases → applyReflectionToMemory → 写入「规则改进」小节
    - 手动入口：POST /api/v1/reflections/apply，前端「反思改进」卡片可手动应用同样的逻辑

