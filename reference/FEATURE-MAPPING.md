# 参考功能映射:llm-agent-workflow(汽车销售智慧工牌)

来源:`reference/llm-agent-workflow/llm-agent-workflow-master`(已解压,2026-02 版本)。
它是一套云知声 agent-frame 的 Python 服务,用多个 LLM workflow(yml 配置)支撑汽车销售场景的对话分析。
本文档把它们映射到本项目(销售军师,Node + pi agent),并标记实现状态与建议。

## 参考功能清单与映射

| # | 参考模块(config 文件) | 参考功能 | 本项目对应实现 | 状态 |
|---|----------------------|----------|----------------|------|
| 1 | uni-dialog-analysis | 通用质检:对话分析(店员/客户角色、合并对话、think) | /copilot/analyze(对话分析,意图/信号/话术/下一步)+ 多轮发言人识别 | ✅ 已实现(等价) |
| 2 | rolecheck-agent | 角色识别:判断店员/客户并打语义标签 | T27 conversation.ts(客户/销售识别:前缀标注 + 交替启发式) | ✅ 已实现(简化版) |
| 3 | general-keywords-extract | 关键词/语义标签抽取 | analyze 的 signals(带 kind/quote/note)+ intent | ✅ 已实现(弱化版) |
| 4 | auto-eval-voice-digest | 试驾场景录音自动总结 | 对话分析模式已覆盖文字稿;录音转写(ASR)为后续 T30 生态 | 🔶 待做(ASR) |
| 5 | discover-frequent-agent | 高频话题/问题挖掘 | 晨报意图分布 + 计划中的「经营洞察」(/assistant/insights) | 🔶 本轮实现 |
| 6 | discover-case-agent | 销售案例挖掘 | T26 知识沉淀(话术候选/入库) | ✅ 已实现(直接对应) |
| 7 | analysis-response-agent | 应答质量评估(评分+改进) | 计划中的「话术评估」模式(/copilot/evaluate-response) | 🔶 本轮实现 |
| 8 | zhiji-semantic-tag-extract | 语义标签抽取(客户画像标签) | customer_tags v7-8 + analyze 自动聚合标签(价格敏感/竞品对比/高意向/流失风险…)+ GET /customers/:key/tags + 前端 badge | ✅ 已实现 |
| 9 | rule-improvement-sop | 质检规则改进标准流程 | 知识沉淀的候选入库机制可承载"规则改进建议" | 🔶 后续增强 |

## 参考项目的价值点(我们可借鉴的工程特征)

- 每个功能 = 配置化的 agent workflow(prompt/模型/参数 yml),便于快速加能力 → 我们以代码固化,配置为 YAML 中心(config model 段),也已支持多 agent(军师/车型/评估)。
- 官方角色判断(role_type_checker + capacity_model_base)用独立小模型做前置分类 → 我们目前用启发式 + 主模型,可在数据量大后加"轻模型预分类"。
- 录音维度(试驾总结)依赖 ASR,暂不引入;先支持文字稿。

## 落地顺序建议

1. ✅ 对话分析 / 角色识别 / 关键词 / 案例沉淀(已实现)
2. 🔶 经营洞察看板(高频意图 + 任务完成率 + 车型偏好)— 本轮
3. 🔶 话术评估模式(应答评分 + 改进点)— 本轮
4. 后续:客户标签聚合、录音总结(ASR)、规则改进 SOP