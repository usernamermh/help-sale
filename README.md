# 助销agent管理平台
![CI](https://img.shields.io/github/actions/workflow/status/usernamermh/help-sale/ci.yml?branch=main&label=CI)
![License](https://img.shields.io/github/license/usernamermh/help-sale)
![Stars](https://img.shields.io/github/stars/usernamermh/help-sale)
![Language](https://img.shields.io/github/languages/top/usernamermh/help-sale)

面向销售团队的助销agent管理平台，以客户会话记录为基础，自动检索团队话术库、识别意向与风险、给出可复制的应对话术与跟进建议，并形成自动闭环。


## 界面截图

![工作台界面](docs/images/Snipaste_2026-09-08_15-07-16.jpg)

![对话分析界面](docs/images/Snipaste_2026-09-08_15-09-37.jpg)

![经营与工具界面](docs/images/Snipaste_2026-09-08_15-44-06.jpg)

## 核心功能实现

### 1. 会话分析

- **入口**，从数据库选取已有会话分析(`POST /api/v1/conversations/:id/analyze`),支持从库内会话原文直接分析。
- **Agent 编排**，会话文本解析为结构化消息后，交给 copilot Agent(基于 pi agent 运行时)执行——自动调用 `knowledge_search` 检索团队话术库、`customer_query` 查询客户档案，最终由 `emit_analysis` 收口输出五要素，**意图(intent)、摘要(summary)、关键信号(signals,含客户原话引用)、应对话术(suggestedReply)、下一步(nextSteps)**。
- **落库**，一次分析同时写入
  - `analyses`(意图/摘要/信号/话术/下一步)
  - `conversations`(会话元数据，客户/销售/时间/消息数)
  - `conversation_messages`(逐句原文，角色/时间/内容)
  - `customer_tags`(自动打标，价格敏感/竞品对比等)
  - `knowledge_candidates`(建议回复满足条件时自动生成话术候选)
- **自动动作**，按分析结果的下一步与建议跟进时间，自动创建跟进任务并进入到期提醒队列。
- **缓存**，相同请求(对话原文+上下文哈希一致)直接复用历史分析记录，不再调用模型。
- **前端**，工作台分析卡片 + 右侧「对话原文」功能区(逐句展示，支持翻页)。

### 2. 话术知识库

- **沉淀(两条路径，统一入库)**
  - 主动沉淀，`knowledge_ingest` 工具批量写入，自动分块(分块大小/重叠可配置)与同名去重;
  - 候选确认，分析自动生成话术候选 → `knowledge_candidate(op=approve)` 确认入库，复用同一套分块/去重/分类逻辑，保证检索质量一致。
- **检索**，`knowledge_search` 工具 → SQLite **FTS5 trigram** 中文子串检索(短词/无命中回退 LIKE);切换 MySQL 模式时降级为 LIKE 检索;确定性查询结果进 `tool_call_cache` 缓存。
- **前端**，知识库标签页(分类批量上传、知识列表、候选确认/拒绝卡片)。

### 3. 跟进任务

- **创建**，`task_manage(op=create)` 为客户创建跟进待办(动作+截止时间),支持按客户姓名自动解析真实客户，校验 `due_at` 合法性，杜绝幽灵客户。
- **自动来源**，会话分析成功后，按分析建议自动创建首条跟进任务。
- **到期提醒**，任务进入提醒队列(Redis ZSET,未启用时退化为内存队列),定时扫描到期任务并推送通知(可配 Webhook)/记录日志;前端任务卡片显示「已到期」标记。
- **管理**，`task_manage(op=list/complete)` 查看待办/已完成、标记完成。

### 4. 经营统计

- **每日晨报**，待办/到期任务、近 24 小时分析量、近 7 天车型方案数、客户数、热门意图分布、优先跟进客户清单。
- **趋势洞察**，近 N 天(默认 7 天)分析量、热门意图、任务完成率、车型偏好(品牌分布)。
- **门店经营概况**，按时间周期统计门店接客次数、成交量、成交额、成交率、成交订单。
- **前端**，洞察晨报标签页;工具 `insight_query(type=morning|trend)` 供 Agent 调用。

### 5. 销售漏斗与客户阶段

- **阶段状态机**，客户可流转 新进店 → 已联系 → 试驾 → 报价 → 成交/战败，记录战败原因与进入阶段时间;`POST /api/v1/customers/:key/funnel` 流转。
- **漏斗看板**，各阶段数量/占比/平均停留、关键转化率(已联系/试驾/报价/成交)、战败原因分布;前端门店管理页展示;工具 `funnel_query`。
- **沉默客户**，近 N 天无会话/任务/试驾的客户自动进入唤醒名单。

### 6. 试驾管理与回访节奏

- **试驾登记**，预约/完成/取消，记录试驾反馈与对比竞品;完成自动把客户推进试驾阶段。
- **自动回访**，试驾完成自动生成 24 小时 / 3 天 / 7 天三段回访任务;提车关怀(3 天回访 + 30 天保养/转介绍提醒)。
- **前端**，工具 `test_drive_manage` + 门店管理接口 `POST/GET /api/v1/test-drives`。

### 7. 销售团队绩效

- **绩效看板**，按销售聚合成交量/额、试驾转化、回访完成率、折扣率与门店排名(`GET /api/v1/stores/:id/performance`)。
- **销售工作台**，今日/逾期待办、跟进中客户、本月成交(`GET /api/v1/sales/:id/workbench`)。

### 8. 定时与主动任务

- **调度器**，服务内每分钟 tick,按租户到点执行——每日晨报(默认 08:00)、每周周报(周一 09:00)、沉默客户唤醒(08:30,自动建唤醒任务),生成后推送通知日志。
- **执行记录**，`automation_runs` 落库(类型/日期/状态/摘要);前端工作台「自动任务」卡片展示并支持手动触发(`GET/POST /api/v1/automations*`)。

### 9. 多代理协作模式

- **自主决策**，规划阶段 `emit_plan` 输出执行模式 —— 任务包含多个相互独立、可并行完成的子目标时，模型自主选择 `multi`(拆 2-6 个子任务给子代理并行执行),否则 `single`(主代理直接执行)。提示词保持中立，不引导模型偏向任何模式。
- **主代理降级为协调者**(multi 模式),主代理只保留 `kanban` / `subagents` / `emit_final` 收口工具，不再注册业务执行工具 —— 只负责子任务规划、看板建卡、结果检查与汇总反馈，业务执行全部交由子代理。
- **子代理并行执行**，消费者从看板取 `pending` 卡片，并发上限 2 个独立 Agent 同时执行(资源隔离，互不抢占);子代理工具白名单硬性排除 `subagents` / `kanban` / `todo_list`,不可再派生子代理、不可修改看板。
- **结果回填**，每个子代理把结论写回看板卡片(`done+result` 或 `error`),协调者读看板核对全部就绪后，汇总输出最终答复(包含每个子任务结论，失败如实说明)。
- **前端**，执行计划卡片展示「多代理并行」与子任务清单;本轮任务面板实时展示建卡/执行进度与每个子任务的结果摘要。

### 10. 反思与自我改进闭环

- **案例采集**，话术评估低分(<70)与 Agent 运行失败自动进入 `reflection_cases`。
- **闭环**，每周一自动聚合改进建议并写入 memory「规则改进」小节(去重),拼入系统提示词影响后续行为;前端「反思改进」卡片可手动应用(`GET/POST /api/v1/reflections`)。

### 11. 上下文压缩与记忆分层

- **三层记忆**，短期=当前轮次+最近消息;中期=会话摘要(thread_summaries);长期=memory.md + 知识库 + 客户档案。
- **超长压缩**，history 超过 30 条时，早期对话压缩为【历史摘要】注入，保留最近 30 条原文;会话摘要自动落库，导出 JSON 带摘要(`GET /api/v1/agent/threads/:id/summary`)。

### 12. 统计图

- **交互式统计图**，工具 `chart_generate` 生成 ECharts 配置(柱状/折线/饼图，支持多系列),聊天端与工作台渲染为可交互图表(tooltip/图例/缩放);工作台经营洞察自带每日分析量柱状图与意图分布饼图。

### 13. 子agent协作看板

- **设计**，看板(kanban)是 agent 之间唯一的通信总线，按**会话(threadId)隔离** —— 用户当前查看哪个历史会话，就展示哪个会话的看板;每个会话保留各自最后一次有效看板记录。
- **卡片模型**，每张卡片含标题、目标(goal)、工具白名单、状态(pending/inprogress/done/error)、执行结果(result)与错误信息。
- **生命周期**，新任务开始时重置当前会话看板(不影响其他会话);删除历史会话时同步清理该会话的看板记录。
- **前端**，顶部「子agent协作看板」按钮 + 右侧面板，卡片按状态分组展示(待执行/执行中/已完成/出错),展示目标、工具、结果全文;切换历史会话时自动加载对应看板(`GET /api/v1/kanban?threadId=`)。

### 14. 真实流式展示与客户端中断

- **真实流式**，模型文本增量(`text_delta`)实时转发前端，边生成边逐字渲染，不再等完整结果后模拟打字机;日志仍只记录完整请求/响应(流式 chunk 不进日志)。
- **客户端中断**，前端「停止」按钮通过 AbortController 取消请求;服务端监听连接断开，触发 agent 终止(取消在途模型请求与工具执行),中断后不落库、不残留部分结果，并回写 cancelled 事件。
- **响应式呈现**，最终答复流式展示后由 `final` 事件全量兜底;表格类结果由工具原文呈现，前端表格控件原样渲染并支持翻页。

## 技术栈

- Node.js >= 24(`node:sqlite`) + TypeScript + Fastify + Vitest
- [pi(0.84.1, earendil-works)](https://github.com/earendil-works/pi)agent 运行时的本地 workspace 构建
- SQLite:FTS5 trigram 中文检索、多租户隔离、分析落库
- 模型，OpenAI 兼容端点(配置驱动);测试用 pi 内置 faux 模型做离线端到端

## 配置

所有运行时配置集中在仓库顶层 **[help-sale.config.yaml](help-sale.config.yaml)**，YAML 格式，**支持 # 注释**，每个字段都写明了作用;覆盖，服务监听、数据目录、默认租户、模型端点/模型名/密钥/代理/上下文窗口(含 `model.extraBody` —— 额外模型参数会统一放进请求体 `extra_body` 字段，不与标准参数平级)、知识分块参数、检索条数、公司与团队名称。

配置只从该文件读取，不支持环境变量覆盖;唯一例外是 `CONFIG_PATH` 用于指定其他配置文件路径。

## 快速开始

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

## 中间件(可选)

- **MySQL**(连接信息在 help-sale.config.yaml mysql 段，按部署环境填入凭据):分析(analyses)与车型优选方案(vehicle_match_plans)自动归档，失败自动降级不影响主流程;可用于后续报表/BI。
- **Redis**(连接信息在 help-sale.config.yaml redis 段，按部署环境填入凭据):跟进任务到期提醒队列;`GET /api/v1/reminders/overdue` 返回已到期待办，前端「跟进任务」卡片显示「已到期」标记，完成即出队。
- 连接信息与开关都在 help-sale.config.yaml(mysql/redis 段),按部署环境填入凭据;`enabled: false` 关闭(Redis 自动退化为内存队列)。


## 工具清单

业务级，`customer_query`(客户)、`conversation_query`(会话)、`knowledge_search`(话术检索)、`knowledge_ingest`(话术沉淀)、`knowledge_candidate`(话术候选)、`task_manage`(跟进任务)、`vehicle_query`(车型)、`insight_query`(经营洞察)、`funnel_query`(销售漏斗)、`test_drive_manage`(试驾管理)。

系统级，`sql`、`redis`、`kanban`、`subagents`、`table_generate`、`chart_generate`、`file_read`、`file_write_new`、`txt`、`excel`、`ppt`、`browser`、`computer`、`update_memory`、`todo_list`、`embedding`、`cluster`、`keyword_extract_free`、`keyword_extract_strict`、`dialog_extract`、`dialog_select`、`date_tool`。
## 目录结构

- `help-sale.config.yaml` 顶层统一配置文件
- `apps/api` 业务服务，db/schema、repositories、services、pi(agent 编排)、routes
- `pi` 上游 agent 运行时(只构建，不修改上游源码)
- `scripts/gen-minimal-model-data.mjs` 离线模型数据生成
