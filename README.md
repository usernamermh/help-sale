# 助销 Agent — 销售军师(Sales Copilot)

面向销售团队的 AI 军师:基于数据库导入导出的客户会话记录,自动检索团队话术库、识别意向与风险、给出可复制的应对话术与跟进建议,**并形成自动闭环(loop agent 设计见规划第 13 章)**。

## 技术栈

- Node.js >= 24(`node:sqlite`) + TypeScript + Fastify + Vitest
- [pi(0.84.1, earendil-works)](https://github.com/earendil-works/pi)agent 运行时的本地 workspace 构建
- SQLite:FTS5 trigram 中文检索、多租户隔离、分析落库
- 模型:OpenAI 兼容端点(配置驱动);测试用 pi 内置 faux 模型做离线端到端

## 配置

所有运行时配置集中在仓库顶层 **[help-sale.config.yaml](help-sale.config.yaml)**,YAML 格式,**支持 # 注释**,每个字段都写明了作用;覆盖:服务监听、数据目录、默认租户、模型端点/模型名/密钥/代理/上下文窗口(含 `model.extraBody` —— 额外模型参数会统一放进请求体 `extra_body` 字段,不与标准参数平级)、知识分块参数、检索条数、公司与团队名称。

配置只从该文件读取,不支持环境变量覆盖;唯一例外是 `CONFIG_PATH` 用于指定其他配置文件路径。

## 快速开始

```bash
npm ci --prefix pi --ignore-scripts
node scripts/gen-minimal-model-data.mjs        # 离线模型数据(models.dev 不可达时)
npm run build:offline --prefix pi
npm install --ignore-scripts                    # 根 workspace 链接 pi 包
npm test                                        # 34 tests
npm run typecheck
```

开发服务:

```bash
npm run dev                                     # 监听 help-sale.config.yaml 中的 host:port
```

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/v1/health | 健康检查 |
| POST | /api/v1/knowledge | 上传知识文档 { title, content }(同名幂等跳过) |
| POST | /api/v1/copilot/analyze | 提交对话分析 { transcript, customerKey? },返回 analysisId |
| POST | /api/v1/copilot/vehicle-match | 车型优选 { customerKey?, requirements } ,返回 planId + plan |
| POST | /api/v1/copilot/evaluate-response | 话术评估 { conversation, reply },返回评分/维度/改进建议 |
| POST | /api/v1/copilot/voice-digest | 通话/试驾文字稿总结 { transcript } |
| GET | /api/v1/assistant/improvements?days=30 | 规则改进建议(优化流失风险/候选流失) |
| GET | /api/v1/assistant/insights?days=7 | 经营洞察(分析量/意图/任务完成率/车型偏好) |
| GET | /api/v1/conversations | 会话列表(时间/ID/销售/客户/消息数) |
| POST | /api/v1/conversations/:id/analyze | 从库内会话原文分析(无需手动粘贴) |
| POST | /api/v1/knowledge/batch | 知识库批量上传(category + entries) |
| GET | /api/v1/conversations/:id/timeline | 分析过程时间线回放 |
| GET | /api/v1/customers/:key/tags | 客户画像标签(自动聚合) |
| POST | /api/v1/notifications/trigger | 推送到期提醒(Webhook,按日志去重) |
| GET | /api/v1/notifications | 通知推送日志 |
| GET | /api/v1/customers/:key/vehicle-plans | 客户车型优选历史 |
| GET | /api/v1/customers/:key/analyses | 客户分析历史 |

请求头 `x-tenant-id` 指定租户(默认见配置 tenant.defaultTenantId)。

## 中间件(可选)

- **MySQL**(连接信息在 help-sale.config.yaml mysql 段,按部署环境填入凭据):分析(analyses)与车型优选方案(vehicle_match_plans)自动归档,失败自动降级不影响主流程;可用于后续报表/BI。
- **Redis**(连接信息在 help-sale.config.yaml redis 段,按部署环境填入凭据):跟进任务到期提醒队列;`GET /api/v1/reminders/overdue` 返回已到期待办,前端「跟进任务」卡片显示「已到期」标记,完成即出队。
- 连接信息与开关都在 help-sale.config.yaml(mysql/redis 段),按部署环境填入凭据;`enabled: false` 关闭(Redis 自动退化为内存队列)。

## 目录结构

- `help-sale.config.yaml` 顶层统一配置文件
- `apps/api` 业务服务:db/schema、repositories、services、pi(agent 编排)、routes
- `pi` 上游 agent 运行时(只构建,不修改上游源码)
- `scripts/gen-minimal-model-data.mjs` 离线模型数据生成
- `docs/plans/2026-08-22-sales-copilot-mvp.md` 完整规划(含 loop 设计)
