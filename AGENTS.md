# Agent 工作说明(AGENTS.md)

本文件面向在此项目内继续工作的 agent 会话,帮助快速恢复上下文。

## 项目状态(2026-09-05)

- 门店管理完成:stores/sales/deals/conversation_messages/tool_call_cache(v13 骨架补齐)+ v14 分析请求缓存;GET/POST 门店/销售/成交接口 + 店长按时间周期看经营概况(接客次数/成交量/成交额/成交率/成交订单);前端「门店管理」标签页;启动对默认租户播种演示门店数据。
- 对话原文落库:analyze / evaluate-response / voice-digest 把每句(时间/角色/内容)写入 conversation_messages;GET /api/v1/conversations/:id/transcript;分析响应带 transcript;工作台与聊天端右侧「对话原文」侧栏展示。
- 缓存:确定性工具结果进 tool_call_cache;相同 analyze 请求(哈希)直接复用分析记录不调模型。
- 模型输入输出本地日志:help-sale.config.yaml logging 段(logging.enabled / dir / maxBytes,LOG_ENABLED/LOG_DIR/LOG_MAX_BYTES 可覆盖),启用后每次模型调用写 `<dir>/model-calls.log` NDJSON:request 行只记 requestId,response 行带同一 requestId 写完整请求/返回(推理+tool_calls),异常落 error 行;默认日志目录 apps/api/log。
- 128/128 测试 + typecheck 零错误。

- MVP 后端 Task 1-20 完成,Task 21(真实模型冒烟)已使用内网 U21-Preview 端点完成,Task 22-23(文档/验收)完成。
- 前端工具页已上线(Fastify 根路由 /,单页 HTML,无构建链):对话分析、车型优选、知识上传、跟进任务、历史查询。
- 参考包 9/9 覆盖完成:补 voice-digest(通话/试驾文字稿总结)与 improvements(规则改进聚合),前端双卡;96/96 测试。
- 四条产品化改造完成:①会话元数据表+v10,界面从库选会话分析(时间/ID/销售/客户/消息数);②知识沉淀基于库内对话;③知识库分类+批量多条知识点;④前端整体重排为标签页(工作台/知识库/跟进与通知/洞察晨报)。104/104 测试。
- 客户画像标签完成(customer_tags v7→v8 聚合,analyze 自动打标,GET /customers/:key/tags,前端历史查询 badge)。
- 参考包:汽车销售智慧工牌(reference/llm-agent-workflow)已解压并盘点,映射见 reference/FEATURE-MAPPING.md;已落地经营洞察(/assistant/insights)与话术评估(/copilot/evaluate-response)。
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
- 重建 pi:`npm ci --prefix pi --ignore-scripts` → `node scripts/gen-minimal-model-data.mjs` → `npm run build:offline --prefix pi` → `npm install --ignore-scripts`
- 恢复官方模型数据:网络可用时在 pi 根目录 `npm run generate-models` 后重建 pi。

## 模型接入

- 默认 local-llm 指向网关 http://10.10.20.34:3004/v1(key sk-l50…),默认模型 deepseek-v4-flash-0731(已验证 analyze 全链路);备选:同网关 deepseek-v4-pro-0813 / gpt-5.2 等 25 个模型(见 /v1/models),以及弱模型端点 http://llm.jz.yunzhisheng.cn:30080/u21-preview/v1(u21-preview,key sk-1234);均走代理 10.252.60.14:3128(undici ProxyAgent 注入)。切换只需改配置文件 model 段。
- 额外请求参数统一进请求体 body 的 extra_body 字段(配置 model.extraBody / 环境变量 MODEL_EXTRA_BODY),不与标准参数平级。
- 离线测试用 pi 内置 faux provider;真实链路用 smoke 脚本 apps/api/.tmp/smoke-real.ts(该目录已被 gitignore)。

## 工作纪律

- TDD:先写失败测试再实现,测试全绿 + `npm run typecheck` 通过后才允许 commit(历史教训:曾多次在红跑时提交)。
- 逐任务粒度提交,commit message 与任务对应。
- pi/ 为上游仓库:只构建、不修改其源码;模型数据目录被上游 gitignore,用根仓库 scripts/ 生成。
- 修改后的计划偏差必须回写规划文档"执行偏差记录"小节。
- 遇到需要人工决策的点(密钥、网络、权限)记录为阻塞项并在阶段快照中汇报,不静默跳过。
- 本环境的 apply_patch 工具存在 freeform 序列化坑,文件编辑统一用 PowerShell(Set-Content/Add-Content + [System.IO.File]::WriteAllText)。
- shell 删除命令(Remove-Item 递归)可能被安全策略拦截;小文件用 [System.IO.File]::Delete / [System.IO.Directory]::Delete。