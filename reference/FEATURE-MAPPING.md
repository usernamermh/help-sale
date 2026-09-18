# 参考功能映射:llm-agent-workflow(汽车销售智慧工牌)

来源:`reference/llm-agent-workflow/llm-agent-workflow-master`(已解压,2026-02 版本)。
它是一套云知声 agent-frame 的 Python 服务,用多个 LLM workflow(yml 配置)支撑汽车销售场景的对话分析。
本文档把它们映射到本项目(销售军师,Node + pi agent),并标记实现状态与建议。

## 参考功能清单与映射

| # | 参考模块(config 文件) | 参考功能 | 本项目对应实现 | 状态 |
|---|----------------------|----------|----------------|------|
| 1 | uni-dialog-analysis | 通用质检:对话分析(店员/客户角色、合并对话、think) | /conversations/:id/analyze(库内会话分析,意图/信号/话术/下一步) | ✅ 已实现(等价) |
| 2 | rolecheck-agent | 角色识别:判断店员/客户并打语义标签 | T27 conversation.ts(客户/销售识别:前缀标注 + 交替启发式) | ✅ 已实现(简化版) |
| 3 | general-keywords-extract | 关键词/语义标签抽取 | analyze 的 signals(带 kind/quote/note)+ intent | ✅ 已实现(弱化版) |
| 4 | auto-eval-voice-digest | 试驾场景录音自动总结 | /copilot/voice-digest(通话/试驾文字稿版:画像/关注点/阶段/建议动作/摘要,复用 agent 栈) | ✅ 已实现(文字稿版;ASR 可后接) |
| 5 | discover-frequent-agent | 高频话题/问题挖掘 | 晨报意图分布 + 计划中的「经营洞察」(/assistant/insights) | 🔶 本轮实现 |
| 6 | discover-case-agent | 销售案例挖掘 | T26 知识沉淀(话术候选/入库) | ✅ 已实现(直接对应) |
| 7 | analysis-response-agent | 应答质量评估(评分+改进) | 计划中的「话术评估」模式(/copilot/evaluate-response) | 🔶 本轮实现 |
| 8 | zhiji-semantic-tag-extract | 语义标签抽取(客户画像标签) | customer_tags v7-8 + analyze 自动聚合标签(价格敏感/竞品对比/高意向/流失风险…)+ GET /customers/:key/tags + 前端 badge | ✅ 已实现 |
| 9 | rule-improvement-sop | 质检规则改进标准流程 | /assistant/improvements:聚合流失风险场景 + 被拒候选,输出改进建议 | ✅ 已实现 |

## 参考项目的价值点(我们可借鉴的工程特征)

- 每个功能 = 配置化的 agent workflow(prompt/模型/参数 yml),便于快速加能力 → 我们以代码固化,配置为 YAML 中心(config model 段),也已支持多 agent(军师/车型/评估)。
- 官方角色判断(role_type_checker + capacity_model_base)用独立小模型做前置分类 → 我们目前用启发式 + 主模型,可在数据量大后加"轻模型预分类"。
- 录音维度(试驾总结)依赖 ASR,暂不引入;先支持文字稿。

## 落地顺序建议

1. ✅ 对话分析 / 角色识别 / 关键词 / 案例沉淀(已实现)
2. ✅ 经营洞察看板 — 已实现
3. ✅ 话术评估模式 — 已实现
4. ✅ 客户标签聚合 / 录音总结(文字稿)/ 规则改进 SOP — 已实现(ASR 转写可后接)
**结论:参考包 9 个 workflow 已 9/9 全部落地到本项目 agent 栈。**