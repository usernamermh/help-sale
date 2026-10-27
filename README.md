# 助销 agent 管理平台

面向销售团队的助销 agent 平台。以会话、客户、话术与知识库为底座,支持多代理协作、工作流沉淀、工具编目与中英双语工具召回。

# 界面截图

### 简单查询
会话/客户查询等基础能力,结果以表格呈现并支持翻页。

![简单查询](docs/images/简单查询.jpg)

### 对话原文抽取
按抽取标准从对话中保真定位并高亮命中片段。

![对话原文抽取](docs/images/对话原文抽取.jpg)

### 标准话术检测
把销售发言与标准话术做原文/语义双通道匹配,输出命中明细与覆盖率。

![标准话术检测](docs/images/标准话术检测.jpg)

### 关键词管理
三级分类目录 + 勾选筛选 + 关键词增删改查。

![关键词管理](docs/images/关键词管理.jpg)

### 绘图和表格
模型直接生成图表,表格由前端控件原样渲染。

![绘图和表格](docs/images/绘图和表格.jpg)

### 定时任务
定时任务管理:内置任务与自定义任务,可查看执行记录与结果。

![定时任务](docs/images/定时任务.jpg)

### 晨报
每日晨报与经营趋势:待办/到期任务、分析量、意图分布。

![晨报](docs/images/晨报.jpg)

### multi agent 模式
多代理并行分析:主代理拆分任务,子代理并行执行,看板协作。

![multi agent模式](docs/images/multi_agent模式.jpg)

# 技术栈

- Node.js ≥ 24(`node:sqlite`)+ TypeScript + Fastify + Vitest
- [pi(0.84.1, earendil-works)](https://github.com/earendil-works/pi) agent 运行时的本地 workspace 构建
- SQLite(默认,含 FTS5 trigram 中文检索)或远程 MySQL(配置切换);Milvus 作为可选向量旁路
- 本地轻量中文向量模型 `Xenova/bge-small-zh-v1.5`(缓存于 `data/models`,缺失时自动回退字符 n-gram)
- 模型:OpenAI 兼容端点,配置驱动(当前指向本地网关 `local-llm` provider)

# 目录结构

```
backend/
  server.ts / app.ts        Fastify 服务入口与路由注册
  env.ts                    配置出口(汇总 configs/ 各段)
  configs/                  配置解析:每个文件对应 yaml 的一段,无默认值
  prompts/                  提示词:系统/规划/协调/工具编目/查询改写
  services/routes/          HTTP 路由(每个文件一个功能域,逻辑与路由同文件)
  services/                 跨功能通用函数(向量库、记忆、时间线、分块、日志…)
  integrations_pi/          pi agent 运行时适配 + 数据表(agents/crm/knowledge/sales/analysis/automation)
  integrations_db/          中间件适配(Redis 到期提醒队列)
  db/                       表结构、迁移、MySQL 客户端
  mcp/                      MCP 客户端 + 工具编目 + 检索(词面 BM25 + 语义 BGE)+ 双语 query 改写
tools/ tools_system/        目录契约工具(readme.json + main.ts),新增工具只需加目录
front/                      前端页面(client.html 业务端 / console.html 控制台)
scripts/                    启动、模型下载、数据导入
opimize/catalog/            检索评测:语料、跑分脚本、报告
```

# 快速开始

```bash
npm ci --prefix pi --ignore-scripts
node scripts/gen-minimal-model-data.mjs        # 离线模型数据(models.dev 不可达时)
npm run build:offline --prefix pi
npm install --ignore-scripts                    # 根 workspace 链接 pi 包
npm test                                        # 25 个测试文件 / 151 个用例
npm run typecheck && npm run typecheck:eval
```

开发服务:

```bash
npm run dev                                     # 监听 help-sale.config.yaml 里的 host:port
```

Windows 一键重启(端口、日志目录都从 yaml 读,不用改脚本):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\restart-service.ps1
```

- 服务默认监听 **3101**(`server.port`),健康检查 `GET /api/v1/health`;
- 日志目录由 `logging.dir` 决定(默认仓库根下 `log/`):`service.log` / `service.err.log` / `runtime.log` / `model-calls.log`;
- 本地向量模型缺失时先跑 `node scripts/download-bge.mjs`(走 hf-mirror)或把已有 `data/models` 复制过来。

# 配置

所有运行时配置集中在仓库顶层 **[help-sale.config.yaml](help-sale.config.yaml)**,YAML 格式、支持注释。**每个字段都是必填**:代码里没有任何默认值,缺一项就在启动时报错并指出配置键;要"关掉/留空"请显式写 `false` / `""` / `[]` / `{}`。模板见 [help-sale.config.example.yaml](help-sale.config.example.yaml)。唯一的环境变量是 `CONFIG_PATH`,用于指定另一份配置文件。

主要配置段:

| 段 | 作用 |
| --- | --- |
| `server` | 监听地址与端口 |
| `data` | 存储模式(`local`=SQLite / `mysql`=远程 MySQL)、库标识、业务表名映射、数据目录与库文件路径 |
| `tenant` | 默认租户(请求未带 `x-tenant-id` 时使用) |
| `model` | 模型名/端点/密钥/代理/上下文窗口/`extraBody` |
| `context.compression` | 长对话增量压缩阈值 |
| `chunker` | 知识分块大小与重叠 |
| `tools.webSearch` | Serper 密钥(`web_search` 工具的启用门槛) |
| `tools.catalog` | 工具编目与召回,见下 |
| `mcp.servers` | 外部 MCP Server 列表 |
| `knowledge.searchLimit` | 知识检索默认条数 |
| `vector` / `milvus_backend` / `milvus_docker_compose` | Milvus 旁路与单机部署参数 |
| `workflows.mine` | 工作流挖掘参数(回溯天数、窗口、最小次数、返回条数、提炼条数、去重) |
| `logging` | 日志开关、目录、级别、运行日志文件名、单文件上限 |
| `subagents` | 多代理并发、轮询间隔、超时、子代理默认工具 |
| `defaults` | 各工具/接口的默认条数与窗口(洞察天数、列表条数、提醒批大小…) |
| `mysql` / `redis` | 中间件连接与开关 |
| `notification` | 到期提醒推送开关与 Webhook |
| `automation` | 定时任务:晨报、周报、沉默客户唤醒的时间与开关 |
| `company` / `userkey` / `client` | 公司名(写入提示词)、调用方标识、前端注入参数 |

# 工具契约(目录工具)

`tools/` 与 `tools_system/` 下每个工具是一个目录,含:

```json
{
  "name": "conversation_query",
  "label": "会话查询",
  "description": "List recent conversations ...",
  "description_language": "en",
  "category": "查询",
  "parameters": { "type": "object", "properties": { "view": { "type": "string" } } },
  "entry": "main.ts",
  "function_list": ["main.execute"],
  "requires": [{ "kind": "config", "key": "tools.webSearch.apiKey", "present": true }],
  "hidden": false
}
```

- `main.ts` 导出 `execute(ctx, params)`(或 `default.execute`),`ctx` = `{ db, tenantId, webSearchApiKey }`;
- `requires` 是环境门槛(配置/环境变量/数据库),不满足时该工具隐藏;
- `hidden: true` 的工具不出现在能力清单(模型仍可调用);
- 新增/修改工具**重启服务即生效**,不需要改后端代码。

当前挂载的本地工具(32 个):`conversation_query`、`customer_query`、`insight_query`、`knowledge_search`、`knowledge_ingest`、`knowledge_candidate`、`playbook_check`、`task_manage`、`workflow_manage`、`browser`、`chart_generate`、`cluster`、`computer`、`date_tool`、`dialog_extract`、`embedding`、`excel`、`file_read`、`file_write_new`、`kanban`、`keyword_extract_free`、`keyword_extract_strict`、`ppt`、`redis`、`similarity`、`sql`、`subagents`、`table_generate`、`terminal`、`txt`、`update_memory`、`web_search`(需配 Serper 密钥)。

# MCP 接入与工具编目

- 在 `mcp.servers` 配外部 MCP Server(含 `pat` 时自动带 `Authorization: Bearer`),它们的工具以 `mcp_{server}_{tool}` 前缀混进工具列表;
- 工具列表按 URL 缓存 5 分钟,传输层对"连不上"重试 3 次;
- 外部工具元数据**含中文会打告警**:这类工具会被判为 `description_language=zh`,只参与中文那一路召回;
- 长尾工具(MCP + 工作流)超过 `tools.catalog.threshold` 后,不再把全部 schema 塞给模型,改为三层工具按需取用。

# 工作流沉淀

`workflow_manage` 管理"执行轨迹 → 可复用工作流"的链路:

- `op=mine`:从历史 `agent_events` 挖掘高频工具串联,产出待审批草稿(参数在 `workflows.mine`);
- `op=list / approve / reject / disable / check`:查看、晋升、驳回、停用启用、静态自检步骤工具是否可用;
- 只有 `status=enabled` 的工作流才会作为 `workflow_<id12>` 工具挂给模型(质量顺序:草稿 → 审批 → 挂载);
- 挂载前会校验步骤引用的工具在当前环境确实加载,不通过则不挂载并在日志点名;
- 工作流的中文名字/描述由挖掘提炼产出,按中文描述参与检索;人工在控制台新建的同样支持中英两种描述。

# 多代理与看板

- `subagents` 工具登记子代理任务,`kanban` 作为主/子代理之间的通信总线(按会话隔离);
- 规划器提示词决定 `single` / `multi`;协调者提示词负责汇总看板结果;
- 并发、轮询间隔、超时、子代理默认工具都在 `subagents` 段配置。

# 知识与话术

- `knowledge_search` / `knowledge_ingest` / `knowledge_candidate`:知识库检索、沉淀候选、审批入库;入库时按 `chunker` 分块并写入 FTS5 trigram 全文索引;
- `playbook_check`:话术命中检测,对会话原文做"原文 + 语义"双通道匹配,输出命中明细与覆盖率;
- `vector` 段开启且 `provider=milvus` 时,知识分块向量写入 Milvus,语义命中走向量检索;`/api/v1/knowledge/vector-*` 提供状态与重建索引。

# 定时任务与通知

- `automation` 段:晨报、周报、沉默客户唤醒的时间与开关,以及是否启用调度器;
- 内置任务与自定义任务都可通过 `/api/v1/automations*` 查看、触发、改期;
- 到期提醒:开启 `redis` 时走 Redis 队列(关闭则退化为内存队列),`notification.webhookUrl` 非空时推送 JSON。

# 数据存储

- `data.mode=local`:SQLite(默认),库文件在 `data.businessDbPath`,会话库在 `sessionDbPath`;
- `data.mode=mysql`:业务表走远程 MySQL,建表语句在 `backend/db/mysql/schema.sql`;
- 业务表名统一在 `data.tables` 映射(租户、客户、会话、消息、待办、知识、候选、事件、标签、通知、门店、销售、成交、工具缓存、日报);
- SQLite 迁移由 `backend/db/migrate.ts` 的 `MIGRATION_VERSION` 推进;`mysql.schemaRebuild=true` 会先删表再建(仅初始化/结构升级用,会清空远程业务表)。

# HTTP API 一览(前缀 /api/v1)

| 域 | 主要接口 |
| --- | --- |
| Agent | `POST /agent/run`、`POST /agent/threads`、`GET /agent/threads/:id`、`POST /agent/threads/:id/run-stream`、`POST /agent/threads/:id/stop`、`GET /agent/:runId/timeline`、`GET /agent/capabilities` |
| 工作流 | `GET/POST /workflows`、`PUT/DELETE /workflows/:id`、`POST /workflows/mine`、`POST /workflows/:id/approve|reject|check`、`GET /workflows/:id/runs` |
| 知识 | `GET /knowledge/search`、`GET /knowledge/semantic-search`、`GET /knowledge/candidates`、`POST /knowledge/candidates/:id/approve|reject`、`GET /knowledge/vector-status`、`POST /knowledge/vector-reindex` |
| 客户/会话 | `GET /conversations`、`GET /conversations/:id/transcript`、`GET /conversations/:id/timeline`、`GET /customers/:key/tags`、`POST /customers/:key/funnel` |
| 销售/门店 | `GET /sales`、`GET /sales/:id/workbench`、`GET /stores`、`GET /stores/:id/overview|performance|funnel|silent-customers`、`GET/POST /deals` |
| 任务/提醒 | `GET /tasks`、`GET /reminders/overdue` |
| 控制台 | `GET /console/logs`、`GET /console/workflows`、`PUT /console/capabilities/:name`、`GET /agent/capabilities` |
| 其他 | `GET /health`、`GET /reflections`、`POST /reflections/apply`、`GET/POST/PUT/DELETE /keywords*`、`/keyword-categories*`、`GET /notifications`、`POST /notifications/trigger`、`GET/POST /subagents`、`POST /subagents/run`、`GET /kanban`、`/automations*`、`/assistant/*` |

# 测试与评测

```bash
npm test                 # 25 个测试文件 / 151 个用例
npm run typecheck        # backend 业务代码
npm run typecheck:eval   # 仓库根,额外覆盖 opimize/ 下的评测脚本
```

检索评测在 `opimize/catalog/`,三套语料各有脚本与报告,直接跑:

```bash
node_modules\.bin\tsx.cmd opimize/catalog/run-eval-recall.ts   # 100 条中文 query 的召回率(recall@1/3/5/8)
node_modules\.bin\tsx.cmd opimize/catalog/run-eval.ts          # 业务测试集:单条 query 四方案 vs 双语召回
node_modules\.bin\tsx.cmd opimize/catalog/run-eval-large.ts    # 干净基准:100 英文 MCP + 100 中文工作流
```

# 常见问题

- **改了工具没生效?** 目录工具是启动时扫描的,重启服务即可(`scripts/restart-service.ps1`)。
- **服务端口/日志在哪?** 都从 `help-sale.config.yaml` 读:端口看 `server.port`,日志看 `logging.dir`(默认 `log/`)。
- **启动报"缺少配置项 xxx"?** 这是刻意设计 —— 该键必须在 yaml 里显式给出,包括空值也要写 `""` / `[]`。
- **MCP 工具检索不准?** 先看日志有没有"元数据含中文"的告警;外部工具按英文描述设计,中文元数据只会走中文那一路召回。
- **本地向量模型没下载?** 语义通道会自动回退字符 n-gram 向量(能跑但效果下降),按"快速开始"里的命令补下载。
- **工作流没有出现在工具列表?** 只有 `status=enabled` 且步骤工具都可用的工作流才会挂载,`workflow_manage(op=check)` 可以自检。
