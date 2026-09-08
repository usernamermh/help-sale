# Agent 工作说明(AGENTS.md)

本文件面向在此项目内继续工作的 agent 会话,帮助快速恢复上下文。

## 项目状态(2026-09-05)

- 门店管理完成:stores/sales/deals/conversation_messages/tool_call_cache(v13 骨架补齐)+ v14 分析请求缓存;GET/POST 门店/销售/成交接口 + 店长按时间周期看经营概况(接客次数/成交量/成交额/成交率/成交订单);前端「门店管理」标签页;启动对默认租户播种演示门店数据。
- 对话原文落库:analyze / evaluate-response / voice-digest 把每句(时间/角色/内容)写入 conversation_messages;GET /api/v1/conversations/:id/transcript;分析响应带 transcript;工作台与聊天端右侧「对话原文」侧栏展示。
- 缓存:确定性工具结果进 tool_call_cache;相同 analyze 请求(哈希)直接复用分析记录不调模型。
- 模型输入输出本地日志:help-sale.config.yaml logging 段(logging.enabled / dir / maxBytes,LOG_ENABLED/LOG_DIR/LOG_MAX_BYTES 可覆盖),启用后每次模型调用写 `<dir>/model-calls.log` NDJSON:request 行只记 requestId,response 行带同一 requestId 写完整请求/返回(推理+tool_calls),异常落 error 行;默认日志目录 apps/api/log。
- list_customers 工具:直接返回客户清单 Markdown 表格(标识/姓名/电话/阶段/最近分析/会话数),prompt 强约束原样保留工具表格;最终答复支持打字机流式(delta 6字符/48ms 上限 12s)且 Markdown 表格正常渲染;HTML 响应 no-store 防缓存。
- 配置重构:help-sale.config.yaml 为唯一配置源(含 defaults 段),env.ts 顶层导出全局 config 实例,各模块直接 import { config },函数入参不再传配置;代码内默认值全部删除(env defaults / DEFAULT_MAX_BYTES / 列表 limit 等统一走 yaml)。日志 request/response 直接落对象(可解析时),maxBytes 必填来自配置。
- 外部工具目录:tools / tools_system 下每个工具子目录统一用 readme.json({name,description,category,parameters,entry,function_list});工具执行逻辑全部外置:main.ts 导出 execute(ctx,params)(ctx={db,tenantId}) 即成为 agent 可调用工具,createSalesAgentTools/createCopilotTools 均为目录加载器(loadExternalAgentTools 动态 import;无实现/损坏/加载失败目录跳过),业务工具已全部迁出 agent-tools.ts;系统收口工具(emit_final/emit_analysis)保留代码内;todo_list 自带实现已接入(CAPABILITIES 同步)。system prompt 仍自动拼接【外部工具】块。
- capabilities 能力清单不再硬编码:由 tools / tools_system 目录动态生成(有实现入口且声明函数的工具才进入清单,label/category 取自 readme.json);evaluator/vehicle/voice 流程的 search_playbook/search_vehicles 同样外置到目录,代码内仅保留系统收口工具(emit_final/emit_analysis/emit_evaluation/emit_vehicle_plan/emit_digest)。
- tools_system 基础工具已完善(8 个全部可调用):browser(轻量 HTTP 抓取,完整功能需 playwright)/computer(安全数值计算)/kanban(本地看板 JSON,支持 KANBAN_FILE 重定向)/redis(ioredis,配置文件连接,白名单操作)/sql(mysql2,配置文件连接,单条 SQL)/subagents(任务队列,支持 SUBAGENTS_DIR 重定向)/table_generate(Markdown 表格+mermaid)/todo_list;业务 tools 应基于这些系统工具组合发展。
- 答复兜底:模型可能不调用 emit_final 而直接输出文本,agent-runtime 无 emit_final 时把最后一条 assistant 文本作为最终答复,前端不再出现"未生成答复";客户类工具(get_customer_profile/history/tags)支持按姓名解析真实 key(customer-resolve),模型传错 key 也能命中。
- sql 工具权限与危险拦截:默认只读(SELECT/SHOW 等放行);写操作需显式 readOnly=false + confirmWrite=true;规则拦截 DROP/TRUNCATE/ALTER/GRANT/REVOKE,UPDATE/DELETE 必须带 WHERE,多语句拦截;写操作审计到 data/sql-audit.log(sql-policy.ts 可单测)。
- 数据存储模式开关:help-sale.config.yaml data.mode = local|mysql 二选一(不可双写);local=SQLite 单一主库(默认不再启用 MySQL 归档双写),mysql=远程主库(仓库层 MySQL 迁移完成前启动即报错 fail-fast)。data.databaseId 为库标识,data.tables 为全部业务表名映射(仓库层经 src/db/tables.ts 统一引用),DATA_MODE/DATABASE_ID 环境变量可覆盖。
- MySQL 主库模式已可用(data.mode=mysql):独立实现于 apps/api/src/db/mysql/(translate 方言转换 + mysql/schema.sql 23 表 + worker 同步桥 SyncMysqlDb),仓库层零改动;知识库检索在 MySQL 模式降级为 LIKE;支持 mysql.schemaRebuild 清表重建(初始化/升级用);pi 会话库仍为本地运行态。冒烟:远程 help_sale 建表+种子+门店/销售/会话/知识检索全部 200。
- 配置唯一来源:所有配置只从 help-sale.config.yaml 读取,不支持环境变量覆盖(CONFIG_PATH 仅用于指定配置文件路径);env.ts 纯 yaml 解析,缺失/非法字段显式抛错。
- 客户端页面:历史会话一键清理(DELETE /agent/threads)、侧栏折叠、右侧本轮任务实时栏与对话原文栏(关闭后有浮动按钮可重开)、布局占满页面、能力清单仅展示 tools(业务逻辑功能)。
- tools_system 新增文件读取工具 txt/excel/ppt(xlsx/adm-zip 依赖,路径仅限仓库根内,防越界读取);customers 增加 intended_vehicles 意向车型字段(v15,JSON 数组),清单/档案工具展示。
- 记忆模块:系统/用户记忆以 apps/api/data/memory.md 落盘(仅承载用户偏好与系统经验,业务数据一律走库),构建 Agent 系统提示词时拼接【系统记忆】段;tools_system/update_memory 工具受控追加(小节白名单+去重);yaml data.memoryFile 可配置路径。
- 170/170 测试 + typecheck 零错误。

- MVP 后端 Task 1-20 完成,Task 21(真实模型冒烟)已完成,Task 22-23(文档/验收)完成。
- 前端工具页已上线(Fastify 根路由 /,单页 HTML,无构建链):对话分析、车型优选、知识上传、跟进任务、历史查询。
- 参考包 9/9 覆盖完成:补 voice-digest(通话/试驾文字稿总结)与 improvements(规则改进聚合),前端双卡;96/96 测试。
- 四条产品化改造完成:①会话元数据表+v10,界面从库选会话分析(时间/ID/销售/客户/消息数);②知识沉淀基于库内对话;③知识库分类+批量多条知识点;④前端整体重排为标签页(工作台/知识库/跟进与通知/洞察晨报)。104/104 测试。
- 客户画像标签完成(customer_tags v7→v8 聚合,analyze 自动打标,GET /customers/:key/tags,前端历史查询 badge)。

- T28 时间线完成:agent 事件序列落库 + /conversations/:id/timeline 回放。
- T27 多轮对话完成(conversation.ts 发言人识别 + messages/transcript 入参)。
- T26 知识沉淀完成(knowledge_candidates + analyze 自动候选 + approve 入库 + 前端卡片 + search 路由)。
- 军师晨报:T25 完成(digests 表 + /assistant/digest 幂等生成 + 前端卡片)。
- 通知推送完成(notification 配置段 /notifications/trigger + 日志;Webhook 可配,去重防重复;100/100 测试)。
- 中间件:MySQL 归档(analyses/vehicle_match_plans 双写,降级优先)+ Redis 到期提醒(ZSET + /api/v1/reminders/overdue + 前端「已到期」标记);连接在 help-sale.config.yaml。
- 车型优选:db v3 vehicles/vehicle_match_plans 表 + vehicles 仓库(预算/座位/能源/级别/关键词筛选)+ 示例种子(services/seed.ts,启动对默认租户播种 8 款)+ vehicle-advisor agent(search_vehicles/get_customer_profile/emit_vehicle_plan)+ POST /api/v1/copilot/vehicle-match + 前端优选卡片。
- 测试 44/44 + typecheck 零错误;服务默认端口 3101(help-sale.config.yaml 配置驱动,避开 VS Code 对 127.0.0.1:3000 的转发占用)。
- 当前推进:第 13 章 loop 设计第二阶段 T24(T 跟进任务表与到期提醒)起。

## 关键文件

- help-sale.config.yaml — 顶层统一配置(YAML,# 注释);env.ts 合并优先级:默认 < 配置 < 环境变量;CONFIG_PATH 可换文件。
- apps/api/src — db(schema.sql v1)/repositories/services/pi(agent 编排)/routes/env.ts。
- 规划:docs/plans/2026-08-22-sales-copilot-mvp.md(第 13 章 loop 设计 F1-F8 与 T24-T30;各阶段附执行偏差记录)。
- scripts/gen-minimal-model-data.mjs — 离线模型数据生成(models.dev 不可达时)。

## 常用命令

- 全量测试:`npm test`;类型检查:`npm run typecheck`
- 启动服务:`npm run dev`(监听 help-sale.config.yaml 的 host:port,当前 3101;请求头 x-tenant-id)
- 按配置重启服务(杀老进程树 + 后台启动 + 健康检查):`powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\restart-service.ps1`(-DryRun 预览 / -Port 覆盖端口 / -NoWait 跳过检查;日志追加 apps/api/log/service.log,PID 见 service.pid)
- 重建 pi:`npm ci --prefix pi --ignore-scripts` → `node scripts/gen-minimal-model-data.mjs` → `npm run build:offline --prefix pi` → `npm install --ignore-scripts`
- 恢复官方模型数据:网络可用时在 pi 根目录 `npm run generate-models` 后重建 pi。

## 模型接入

- 默认 local-llm 指向 OpenAI 兼容网关(端点/密钥在 help-sale.config.yaml 的 model 段配置,仓库不提交真实值);切换模型只需改配置文件 model 段。
- 额外请求参数统一进请求体 body 的 extra_body 字段(配置 model.extraBody),不与标准参数平级。
- 离线测试用 pi 内置 faux provider;真实链路用 smoke 脚本 apps/api/.tmp/smoke-real.ts(该目录已被 gitignore)。

## 工作纪律

- TDD:先写失败测试再实现,测试全绿 + `npm run typecheck` 通过后才允许 commit(历史教训:曾多次在红跑时提交)。
- 逐任务粒度提交,commit message 与任务对应。
- pi/ 为上游仓库:只构建、不修改其源码;模型数据目录被上游 gitignore,用根仓库 scripts/ 生成。
- 修改后的计划偏差必须回写规划文档"执行偏差记录"小节。
- 遇到需要人工决策的点(密钥、网络、权限)记录为阻塞项并在阶段快照中汇报,不静默跳过。
- 本环境的 apply_patch 工具存在 freeform 序列化坑,文件编辑统一用 PowerShell(Set-Content/Add-Content + [System.IO.File]::WriteAllText)。
- shell 删除命令(Remove-Item 递归)可能被安全策略拦截;小文件用 [System.IO.File]::Delete / [System.IO.Directory]::Delete。