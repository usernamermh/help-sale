# 工具检索(编目)离线评测报告

> 当前生产方案:**双语 query 改写 → 按工具描述语言分别召回 → 两段分开返回**(不跨语言混排,见 §2)。
> 代码:`backend/mcp/retrieval.ts`(双通道 + 按语言分池召回 + 两段分开返回)、`backend/mcp/query-rewrite.ts`(改写)、
> `backend/mcp/catalog.ts`(编目)、`backend/prompts/tool-discovery.ts`(提示词)、
> `backend/integrations_pi/agent-runtime.ts`(触发时机)。
> 原始跑分:`last-run.txt`;对照(`--meta=zh`,本地工具用中文快照):`last-run-zh.txt`。

---

## 0. 干净基准(100 英文 MCP + 100 中文工作流,只测双语召回)

语料与用例由脚本生成(`fixtures/gen-large-suite.mjs`),两边完全对称、每条用例的正确答案固定在其中一个语言的池子里。
跑分:`npx tsx opimize/catalog/run-eval-large.ts`,原始输出 `large-run.txt`。

| 组 | 用例数 | 该段平均条数 | Top1 | Top3 | Top8 | MRR | 另一段平均条数 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| MCP(英文池) | 100 | 8.0 | **100.0%** | 100.0% | 100.0% | 1.000 | 5.19 |
| 工作流(中文池) | 100 | 8.0 | 81.0% | 91.0% | **100.0%** | 0.878 | 7.69 |
| **合计** | 200 | 8.0 | **90.5%** | **95.5%** | **100.0%** | 0.939 | 6.44 |

未进前三名的 9 条全部是同一族:中文改写用了同义词("检查一下会话合不合规")而没有复现工作流名里的"质检"一词,
同一业务对象下有 10 个工作流互相竞争,正确答案掉到第 4-7 名(Top8 仍然 100%)。属"改写用词与工具用词不一致",不是召回缺陷。

**这个基准改掉了两件事**:
1. 原来把两路结果 RRF 融合成一条榜单 —— 两段的第 1 名分数恒等(都是 1/(k+1)),谁在前只能按名字猜,实测 `mcp_*` 压过 `workflow_*`,中文工作流 Top1 直接 0%;
2. 现在**两段分开返回**(`【中文描述的工具】` / `【英文描述的工具】`),跨语言谁更相关交给模型按描述判断 —— MCP 组 Top1 恢复到 100%,工作流组 0% → 81%。
## 1. 一句话结论

目录里中英工具混装时,**模型自己写的一条 query 只能命中同一语言的那批工具**(命中按语言分派,不按相关度)。
把用户问题改写成 `{zh,en}` 两条、各自只召回"同语言描述"的工具、再融合,这条分派就消失了:

| 指标(生产编目语料,46 条用例全量) | 单条 query | 双语召回 |
| --- | --- | --- |
| Top1 命中 | 45.0% | **92.5%** |
| Top3 命中 | 52.5% | **97.5%** |
| Top8 命中 | 70.0% | **100%** |
| MRR | 0.511 | **0.954** |
| mcp 类 Top3(中文问句找英文工具) | 25.0% | **100%** |

---

## 2. 运行流程(每一步的落点)

1. **挂载工具**(`createSalesAgentTools`):本地工具直挂;长尾 = MCP + 工作流。
2. **判阈值**:长尾数量 > `tools.catalog.threshold`(20)→ 进编目模式,并把 `{active, toolCount}` 写回宿主(`ToolRecallState.catalog`)。
3. **触发 query 改写**(`agent-runtime.ts`,仅编目模式 + 开关打开):一次模型调用,要求输出
   `{"zh":"中文检索词","en":"English search keywords"}`;超时/解析失败/开关关闭都退回用户原话,不阻塞本轮。
4. **两条 prompt 分别召回**(`ToolRetriever.searchBilingual`):
   - zh query → 只在 `description_language = zh` 的候选池里召回;
   - en query → 只在 `description_language = en` 的候选池里召回(两侧 query 由测试集的 queryZh/queryEn 提供,98 条用例全量可比);
   - 模型自己那次 `search_tools` 的 query 也算一路(它会按上一次结果换说法),按语言进对应池子;
   - 每路都是"词面 BM25 + 语义 BGE"双通道,再按语言取各自的语义下限。
5. **两段分开返回**给模型:【中文描述的工具】+【英文描述的工具】,跨语言谁更相关由模型按描述判断 → get_tool_details → call_tool。

模型看到的工具清单永远是英文名 + 英文/中文描述 + `search_tools` 提示词,不需要猜工具是哪种语言写的。

---

## 3. `description_language` 怎么来

| 工具来源 | 来源 | 说明 |
| --- | --- | --- |
| 本地目录工具 | `readme.json` 的 `description_language` 字段 | 32 个工具当前都是 `en`(描述已英文化);缺省时按描述文本推断(含中文即 zh) |
| 外部 MCP 工具 | 按 name/description 自动判定 | 中文描述 → `zh`(只进中文那一路);同时打日志告警提示对方给英文元数据 |
| 工作流 | 按 name/description 自动判定 | **挖掘默认产出中文**,所以默认走 zh 那一路;写成英文的自动走 en 那一路 |

同一个工作流不要中英混写;两种语言都支持,各自只在自己那一路竞争。

---

## 4. 配置项(全部在 `help-sale.config.yaml`)

```yaml
tools:
  catalog:
    enabled: true            # 是否启用编目(关闭则长尾工具直挂、不改写)
    threshold: 20            # 长尾工具(含 MCP)超过这个数就进编目 + 触发 query 改写
    topK: 8                  # search_tools 默认返回条数
    maxInspect: 3            # 单次运行 get_tool_details 调用上限
    semanticFloorZh: 0.45    # 中文候选池的语义下限(挡闲聊)
    semanticFloorEn: 0.6     # 英文候选池的语义下限(BGE 对同语种打分更高,必须分开配)
    bilingual:
      enabled: true          # 双语改写 + 分语言召回总开关
      rewriteTimeoutMs: 20000# 改写模型调用超时(超时退回用户原话)
      perLanguageTopK: 8     # 每种语言各召回多少条进融合
```

为什么下限要按语言分开(实测 BGE 余弦分布):

| 查询 | 中文池最高分 | 英文池最高分 |
| --- | --- | --- |
| 闲聊(你好 / tell me a joke / thanks for your help / what is your name) | 0.44 / 0.36 / 0.42 / 0.30 | 0.44 / 0.48 / 0.53 / **0.55** |
| 正例(把这个 PR 合并掉 / merge this pull request) | 0.52 | **0.75** |
| 正例(把最近的会话记录调出来 / list the recent conversations) | 0.53 | **0.67** |

中文闲聊 ≤0.44、英文闲聊 ≤0.55,而正例 ≥0.65 —— 所以 zh 取 0.45、en 取 0.6 能同时挡住两边、又不误伤正例。

---

## 5. 结果

### 5.1 双语召回 vs 单条 query(成对用例,直接可比)

测试集 98 条**全部**配了中英两侧 query(`queryZh` / `queryEn`),两种方案面对完全相同的用例:

全量语料(81 工具 / 98 条用例):

| 方案 | Top1 | Top3 | Top8 | MRR | P@3 | 闲聊返回空 |
| --- | --- | --- | --- | --- | --- | --- |
| ④ 单条 query(改造前) | 43.5% | 54.3% | 65.2% | 0.504 | 18.0% | 100% |
| ⑤ **双语召回(当前生产)** | **78.3%** | **90.2%** | **94.6%** | **0.841** | **28.6%** | 83.3% |

分类型 Top3(同一批用例):

| 方案 | local | mcp | mixed | rewrite | en |
| --- | --- | --- | --- | --- | --- |
| ④ 单条 query | 59.4% | 25.0% | 62.5% | 20.0% | 86.4% |
| ⑤ 双语召回 | **84.4%** | **100%** | **100%** | **80.0%** | **90.9%** |

生产编目语料(49 工具 / 46 条用例):⑤ Top1 92.5%、Top3 97.5%、Top8 100%、MRR 0.954;④ 对应为 45.0% / 52.5% / 70.0% / 0.511。

### 5.2 单条 query 的四种方案(98 条用例,作为基线保留)

| 方案 | Top1 | Top3 | Top8 | MRR | P@3 | 闲聊返回空 |
| --- | --- | --- | --- | --- | --- | --- |
| ① 旧方案 裸子串+词边界 | 42.4% | 57.6% | 60.9% | 0.491 | 19.0% | 100% |
| ② 词面 BM25 | 44.6% | 55.4% | 63.0% | 0.511 | 18.0% | 100% |
| ③ 语义 BGE 向量 | 26.1% | 32.6% | 34.8% | 0.295 | 10.5% | 100% |
| ④ 双通道(单条 query) | 43.5% | 54.3% | 65.2% | 0.504 | 18.0% | 100% |

注:③④ 在"中文 query 打英文工具"这类跨语言句对上明显偏低,正是因为语义通道被 en 下限(0.6)挡住 ——
这恰好说明**语义通道救不了跨语言**,必须靠改写提供同语言 query(这正是 ⑤ 的收益来源)。

### 5.3 残留问题(诚实记录)

| 问题 | 现象 | 处理 |
| --- | --- | --- |
| 闲聊仍偶有命中 | 双语召回下 6 条闲聊里 1 条返回工具(`你叫什么名字?` → `mcp_github_get_label` 等),平均返回 1.33 条 | 命中来自**词面**通道的泛词("name" 命中参数名 `name`),语义下限管不到。已加提示词规则:无需工具的问题两条 rewrite 都写空字符串(空 = 跳过召回);改写提示词里也禁止"硬凑检索词" |
| `rw-07` 近失 | `上周都聊了些什么,帮我回顾一下` → 期望 `conversation_query`,实际排第 5(在 Top8 内) | 属"对象词缺失"类,靠模型改写里补 `conversation` 可解 |

---

## 6. 怎么复跑

```bash
cd E:\proj_help_sale_v2
node_modules\.bin\tsx.cmd opimize/catalog/run-eval.ts --out=opimize/catalog/last-run.txt            # 当前(本地工具英文)
node_modules\.bin\tsx.cmd opimize/catalog/run-eval.ts --meta=zh --out=opimize/catalog/last-run-zh.txt # 本地工具中文对照
node_modules\.bin\tsx.cmd opimize/catalog/run-eval.ts --corpus=catalog --verbose                     # 只看编目语料 + 逐条
npm run typecheck && npm run typecheck:eval && npm run test
```

机制单测(不依赖真实模型):`backend/mcp/retrieval.test.ts`(分语言池 / 双语融合 / 模型自补 query)、
`backend/mcp/query-rewrite.test.ts`(改写 JSON 解析)、`backend/mcp/catalog.test.ts`、`backend/mcp/client.test.ts`。

---

## 7. 线上实测

真实模型 + 真实链路(本地工具 + 一个中文工作流 + 46 个英文 MCP 工具):

```
用户问题:帮我把上周的客户跟进复盘一下,顺便看看有没有该建的待办
改写结果:{"zh":"复盘上周客户跟进 查找待办事项","en":"review weekly customer follow-up list todos"}
候选池:  zh 1 个 / en 46 个
召回:    bilingual 模式,中文工作流与英文 MCP 工具同时进候选
```

- 首次检索 ~13s(本地 BGE 懒加载),之后每次 ~30ms;改写是**每轮一次**模型调用(超时可配,失败退回原话);
- 服务 3101 已按新配置重启;`npm run test` 25 个文件 / 151 个用例全绿。