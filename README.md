# 助销 Agent — 销售军师(Sales Copilot)

面向销售团队的 AI 军师:粘贴一段客户沟通记录,自动检索团队话术库、识别意向与风险、给出可复制的应对话术与跟进建议,**并形成自动闭环(loop agent 设计见规划第 13 章)**。

## 技术栈

- Node.js >= 24(`node:sqlite`) + TypeScript + Fastify + Vitest
- [pi(0.84.1, earendil-works)](https://github.com/earendil-works/pi)agent 运行时的本地 workspace 构建
- SQLite:FTS5 trigram 中文检索、多租户隔离、分析落库
- 模型:deepseek(生产默认)/ openai;测试用 pi 内置 faux 模型做离线端到端

## 快速开始

```bash
npm ci --prefix pi --ignore-scripts
node scripts/gen-minimal-model-data.mjs        # 离线模型数据(models.dev 不可达时)
npm run build:offline --prefix pi
npm install --ignore-scripts                    # 根 workspace 链接 pi 包
npm test                                        # 33 tests
npm run typecheck
```

开发服务:

```bash
# 可选:注入真实模型
$env:DEEPSEEK_API_KEY = "..."
npm run dev                                     # 监听 :3000
```

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/v1/health | 健康检查 |
| POST | /api/v1/knowledge | 上传知识文档 { title, content }(同名幂等跳过) |
| POST | /api/v1/copilot/analyze | 粘贴对话分析 { transcript, customerKey? },返回 analysisId |
| GET | /api/v1/customers/:key/analyses | 客户分析历史 |

请求头 `x-tenant-id` 指定租户(默认 t_demo)。

## 目录结构

- `apps/api` 业务服务:db/schema、repositories、services、pi(agent 编排)、routes
- `pi` 上游 agent 运行时(只构建,不修改上游源码)
- `scripts/gen-minimal-model-data.mjs` 离线模型数据生成
- `docs/plans/2026-08-22-sales-copilot-mvp.md` 完整规划(含 loop 设计)

## 已知人工介入点

- 真实模型冒烟(Task 21)需要 `DEEPSEEK_API_KEY`