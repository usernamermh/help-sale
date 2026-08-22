# Agent 工作说明(AGENTS.md)

本文件面向在此项目内继续工作的 agent 会话,帮助快速恢复上下文。

## 项目状态

- MVP 阶段 Task 1-20 完成(33/33 测试 + typecheck 零错误);Task 21 等待 DEEPSEEK_API_KEY;Task 22 文档本轮完成;Task 23 收尾待最终验收。
- 规划与 loop 设计:docs/plans/2026-08-22-sales-copilot-mvp.md(含第 13 章 Loop Agent 产品设计 F1-F8 与 T24-T30)。

## 常用命令

- 全量测试:`npm test`(vitest,apps/api)
- 类型检查:`npm run typecheck`
- 启动服务:`npm run dev`(监听 :3000;请求头 x-tenant-id)
- 重建 pi:`npm ci --prefix pi --ignore-scripts` → `node scripts/gen-minimal-model-data.mjs` → `npm run build:offline --prefix pi` → `npm install --ignore-scripts`
- 恢复官方模型数据:网络可用时在 pi 根目录 `npm run generate-models`(会覆盖 data/ 目录,重建 pi)。

## 工作纪律

- TDD:先写失败测试再实现,测试全绿 + `npm run typecheck` 通过后才允许 commit(历史教训:曾三次在红跑时提交)。
- 逐任务粒度提交,commit message 与任务对应。
- pi/ 为上游仓库:只构建、不修改其源码;构建所需本地工具放根仓库 scripts/。
- 修改后的计划偏差必须回写规划文档"执行偏差记录"小节。
- 遇到需要人工决策的点(密钥、网络、权限)记录为阻塞项并在阶段快照中汇报,不静默跳过。