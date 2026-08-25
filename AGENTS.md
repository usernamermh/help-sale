# Agent 工作说明(AGENTS.md)

本文件面向在此项目内继续工作的 agent 会话,帮助快速恢复上下文。

## 项目状态(2026-08-25)

- MVP 后端 Task 1-20 完成,Task 21(真实模型冒烟)已使用内网 U21-Preview 端点完成,Task 22-23(文档/验收)完成。
- 前端工具页已上线(Fastify 根路由 /,单页 HTML,无构建链):对话分析、知识上传、历史查询。
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

- 默认 local-llm(u21-preview,http://10.252.60.39:31883/v1,key 任意);provider 实现在 apps/api/src/pi/local-provider.ts。
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