# 业务级 Tools 梳理与重组设计
> ## 实施状态(2026-09-08)
>
> - ✅ 6 个幽灵工具已迁移至 tools_system 并实现:embedding(本地字符 n-gram 向量)/ cluster(KMeans)/ keyword_extract_free / keyword_extract_strict / dialog_extract(复用 parseTranscript)/ dialog_select。
> - ✅ 业务工具重组完成:tools 目录收敛为 9 个(customer_query / conversation_query / knowledge_search / knowledge_ingest / knowledge_candidate / task_manage / vehicle_query / insight_query / date_tool),旧 18 个业务工具目录已下线。
> - ✅ P0 修复:knowledge_candidate 的 approve 复用标准 ingest(分块/去重/分类);task_manage 的 create 复用客户姓名解析并校验 due_at;file_read 补行分页;提示词补检索无命中引导沉淀。
> - ✅ 关联更新:copilot/evaluator/vehicle/voice 装配与提示词、翻页白名单、前端分页工具清单、全部受影响测试。


> 日期:2026-09-08
> 范围:tools(业务级)与 tools_system(系统级)全部目录,基于当前代码实现盘点。
> 目的:梳理现状、识别冗余与重叠,并给出"由系统工具 + 共享服务组合而来"的业务工具重组方案。

---

## 一、现状梳理

### 1.1 业务级 tools(共 24 个目录)

| 工具 | 分类 | 核心实现 | 状态 |
| --- | --- | --- | --- |
| list_customers | 客户 | repositories/customers.listCustomers | ✅ 可用(分页 10 行/页) |
| get_customer_profile | 客户 | services/customer-resolve + repositories/customers | ✅ 可用(支持按姓名解析) |
| get_customer_history | 客户 | services/customer-resolve + repositories/analyses | ✅ 可用 |
| get_customer_tags | 客户 | services/customer-resolve + repositories/customer-tags | ✅ 可用 |
| list_conversations | 会话 | repositories/conversations | ✅ 可用 |
| load_conversation | 会话 | repositories/conversations + conversation-data | ✅ 可用 |
| search_playbook | 知识 | repositories/knowledge.searchKnowledge + withToolCache | ✅ 可用(FTS 检索) |
| ingest_knowledge | 知识 | services/ingest.ingestEntries | ✅ 可用(分块/去重/分类) |
| list_knowledge_candidates | 知识 | repositories/knowledge-candidates | ✅ 可用 |
| approve_knowledge_candidate | 知识 | repositories/knowledge-candidates.approveCandidate | ✅ 可用(⚠️ 手写 SQL 入库) |
| reject_knowledge_candidate | 知识 | repositories/knowledge-candidates.rejectCandidate | ✅ 可用 |
| create_task | 任务 | repositories/tasks + customers | ✅ 可用(⚠️ 未复用客户姓名解析) |
| list_tasks | 任务 | repositories/tasks | ✅ 可用 |
| complete_task | 任务 | repositories/tasks.setTaskStatus | ✅ 可用 |
| search_vehicles | 车型 | repositories/vehicles + withToolCache | ✅ 可用 |
| build_morning_digest | 经营 | services/digest.collectDigest | ✅ 可用 |
| collect_insights | 经营 | services/insights.collectInsights | ✅ 可用 |
| week2date | 通用 | main.py(Python) | ✅ 可用(文本日期替换) |
| cluster | 通用 | 无 main.ts | ⚠️ 待实现(幽灵工具) |
| embedding | 通用 | 无 main.ts | ⚠️ 待实现(幽灵工具) |
| keyword_extract_free | 通用 | 无 main.ts | ⚠️ 待实现(幽灵工具) |
| keyword_extract_strict | 通用 | 无 main.ts | ⚠️ 待实现(幽灵工具) |
| dialog_extract | 通用 | 无 main.ts | ⚠️ 待实现(幽灵工具) |
| dialog_select | 通用 | 无 main.ts | ⚠️ 待实现(幽灵工具) |

> 说明:"幽灵工具"只有 readme.json、无实现入口,当前不会注册为可调用工具,但仍出现在系统提示词【外部工具】块中,属待实现能力。

### 1.2 系统级 tools_system(能力原语)

| 工具 | 能力域 | 职责 |
| --- | --- | --- |
| sql | 数据存取 | 当前 data.mode 业务库(local/mysql 二选一),只读默认 + 写操作审计拦截 |
| redis | 数据存取 | 键值/队列白名单操作 |
| kanban | 协作 | 本地 JSON 看板(多任务共享状态) |
| subagents | 协作 | 子代理任务队列(JSON) |
| todo_list | 流程 | 会话内待办规划(内存态,重启即丢) |
| table_generate | 呈现 | 二维数组/对象数组 → Markdown 表格 + mermaid(分页 10 行/页) |
| txt | 文件读取 | 仓库内文本文件(受限) |
| excel | 文件读取 | 仓库内 Excel/CSV(受限,分页) |
| ppt | 文件读取 | 仓库内 PPTX(受限) |
| file_read | 文件读取 | 任意路径 txt/xlsx/pdf/pptx/docx 等 |
| file_write_new | 文件写入 | 任意路径创建新文件(绝不覆盖现有) |
| browser | 浏览器 | HTTP 轻量抓取 |
| computer | 数值计算 | 安全表达式求值 |
| update_memory | 记忆 | memory.md 追加/去重,拼入系统提示词 |

### 1.3 共享服务(业务工具复用的基础能力)

| 共享能力 | 位置 | 说明 |
| --- | --- | --- |
| customer-resolve | apps/api/src/services/customer-resolve.ts | 客户 key/姓名解析,防幽灵客户 |
| ingest | apps/api/src/services/ingest.ts | 知识分块/去重/分类入库 |
| digest / insights | apps/api/src/services/ | 晨报与经营洞察统计 |
| withToolCache | apps/api/src/repositories/conversation-data.ts | 确定性工具结果缓存(相同参数不再重复计算) |
| config | apps/api/src/env.ts | 唯一配置源(yaml) |
| table_generate 核心 | tools_system/table_generate/main.ts | Markdown 表格渲染(业务工具应复用而非手拼) |

---

## 二、现状问题分析

### 2.1 功能冗余与重叠

1. **文件读取三件套 vs file_read**
   txt/excel/ppt 仅限仓库内,file_read 任意路径且覆盖更多格式(txt/xlsx/pdf/pptx/docx)。三件套仅剩"excel 分页"这一差异化能力。建议 file_read 补分页后,三件套降级或下线。

2. **todo_list vs 业务任务(create/list/complete_task)**
   都是"任务",但 todo_list 为内存态(重启丢失),业务任务为 DB 持久化并绑定客户。边界不清,模型易选错。

3. **话术沉淀双写入路径**
   ingest_knowledge 走 ingest(分块/去重/分类);approve_knowledge_candidate 手写 SQL 单 chunk 入库且不带 category。两条路径数据形态不一致,影响检索质量。

4. **build_morning_digest vs collect_insights**
   均做经营统计,口径重叠(晨报含待办/到期/近24h分析,洞察含近N天分析/热门意图/完成率/车型偏好)。晨报应复用洞察统计服务,避免两套统计逻辑。

### 2.2 能力复用不一致

- create_task 未复用 customer-resolve:传错客户名会 upsert 幽灵客户;而 get_customer_* 三件套已支持按姓名解析。
- approve_knowledge_candidate 未复用 ingest:跳过标准分块/分类。
- 业务工具输出表格多为手拼字符串,未复用 table_generate 的渲染/分页能力(仅 list_customers 有 rawTable 约定)。

### 2.3 流程断点

- search_playbook 无命中时仅返回"知识库未命中",未引导沉淀(建候选或 ingest)。
- 候选列表(list_knowledge_candidates)无批量操作,候选多时逐个 approve/reject 成本高。
- create_task 未校验 due_at 合法性(tasks 表为 next_step_tasks,仅 due_at 无 remind_at,到期提醒基于 due_at);参数缺省校验,易产生脏数据。

---

## 三、基于系统工具的重新组织方案

### 3.1 分层模型

```
┌─ 组合层:高频业务动作(晨报、客户画像、跟进周报)——由领域层工具编排,少量新增
├─ 领域层:业务工具(tools/)——领域查询/写入 + 复用系统能力组件,不裸拼
├─ 原语层:系统工具(tools_system/)——数据存取/文件/计算/呈现/记忆/协作
└─ 共享服务层:repositories + services + _shared(被两层共同 import)
```

架构原则:

1. **业务工具不运行时调用系统工具**(如 create_task 内部调 sql),避免嵌套调用、错误传播复杂、丢失类型安全;改为"编译期复用共享组件"(import repositories/services/_shared)。
2. **系统工具 = 给 LLM 的通用原语;业务工具 = 给 LLM 的领域封装**。同一能力在两层复用同一份实现。
3. **低频动作不建工具**:模型直接用 sql + table_generate 现场组合;只有高频、易错、需要统一口径的动作才沉淀为业务工具。

### 3.2 最终成立的业务级 tools 清单(9 个)

> 聚合原则:同一领域的高频操作合并为一个工具(通过 op/view/type 参数区分),减少模型选择成本、统一参数校验与输出口径;文件类能力由系统工具承担,业务侧不重复建。

| # | 工具 | 领域 | 职责 | 主要参数 | 组合来源 | 替代现状 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | customer_query | 客户 | 客户查询(列表/档案/历史/标签),分页 10 行/页,支持按姓名解析 | view=list\|profile\|history\|tags, customerKey, page | sql(读) + customer-resolve + table_generate + withToolCache | list_customers、get_customer_profile、get_customer_history、get_customer_tags |
| 2 | conversation_query | 会话 | 会话列表/对话原文查询 | view=list\|load, conversationId, page | sql(读) + conversation-data + table_generate + withToolCache | list_conversations、load_conversation |
| 3 | knowledge_search | 知识 | 话术/政策/竞品 FTS 检索,无命中时提示可沉淀 | query, category, page | sql(FTS) + withToolCache + table_generate | search_playbook |
| 4 | knowledge_ingest | 知识 | 话术批量沉淀(分块/去重/分类) | category, entries[] | ingest 服务(分块/去重/分类) | ingest_knowledge |
| 5 | knowledge_candidate | 知识 | 话术候选列表/确认入库/拒绝;approve 复用标准入库 | op=list\|approve\|reject, candidateId, page | sql + ingest(approve 时统一分块/分类/去重) | list_knowledge_candidates、approve_knowledge_candidate、reject_knowledge_candidate |
| 6 | task_manage | 任务 | 跟进任务创建/列表/完成;create 按姓名解析客户、校验 due_at | op=create\|list\|complete, customerKey, action, dueAt, page | sql + customer-resolve + table_generate + withToolCache | create_task、list_tasks、complete_task |
| 7 | vehicle_query | 车型 | 车型检索(预算/座位/能源/关键词) | budgetMin, budgetMax, seats, energyType, keyword, page | sql + withToolCache + table_generate | search_vehicles |
| 8 | insight_query | 经营 | 经营洞察:晨报(待办/到期/近24h)/趋势(近N天分析/意图/完成率/车型偏好) | type=morning\|trend, days | digest/insights 统计服务 + table_generate | build_morning_digest、collect_insights |
| 9 | date_tool | 通用 | 把"下周X/周X"等相对日期替换为绝对日期 | text, baseDate | computer/正则(原 main.py) | week2date |

> 文件能力:file_read / file_write_new 保留在 tools_system,作为系统原语被上面工具与模型共用,业务侧不重复注册。

#### 待实现工具补齐后的归属

| 待实现 | 补齐后归属 |
| --- | --- |
| dialog_extract / dialog_select | 会话域(conversation_query 的补充,或独立"对话处理"工具) |
| keyword_extract_free / keyword_extract_strict | 会话/标签域(get_customer_tags 的上游) |
| cluster / embedding | 通用算法原语,供 keyword/dialog 组合,不进业务清单 |
### 3.3 合并/拆分/下线清单

- **合并(14 个现有工具 → 5 个聚合工具)**:客户 4 合 1(customer_query)、会话 2 合 1(conversation_query)、知识候选 3 合 1(knowledge_candidate)、任务 3 合 1(task_manage)、经营 2 合 1(insight_query)。
- **更名(3 个)**:search_playbook → knowledge_search、ingest_knowledge → knowledge_ingest、week2date → date_tool(保持原有实现)。
- **保留(1 个)**:search_vehicles → vehicle_query(仅补齐分页与统一输出)。
- **下线**:txt/excel/ppt(file_read 补齐分页后);todo_list 或改为持久化,或明确为"会话内草稿"。
- **系统工具保留**:file_read、file_write_new 作为原语供业务工具与模型共用。

### 3.4 工具注册规范(readme.json 契约)

每个业务工具目录必须:

1. readme.json 含 name/label/description/category/parameters/entry/function_list;
2. main.ts 导出 execute(ctx, params)(ctx={db, tenantId});
3. 复用共享组件(不得手写 SQL 字符串拼接表格、不得重复实现客户解析/分块);
4. 表格类输出带 details.rawTable,供前端原样渲染与翻页;
5. 确定性查询包 withToolCache,避免重复调模型。

---

## 四、沉淀机制(用户常用业务工具如何固化)

1. **使用统计**:agent-events 已记录 tool_start/tool_end,按周聚合"调用次数/成功率/失败原因",生成高频工具榜。
2. **高频固化**:周榜 Top 工具人工确认后:
   - 置顶 prompt(提高模型选择优先级);
   - 或把多次组合沉淀为新业务工具(如"跟进周报"= customer_query + task_manage + insight_query);
   - 新工具自动进入系统提示词与前端"业务逻辑功能"清单。
3. **经验沉淀**:工具失败原因写入 memory.md「工具经验」小节(update_memory),或走 knowledge_candidates 候选-确认流,避免脏数据直接污染提示词。
4. **话术沉淀闭环**:search_playbook 无命中且内容有沉淀价值时,模型引导创建候选或直接 ingest;候选确认复用标准入库,保证检索质量一致。

---

## 五、实施路线

| 阶段 | 内容 | 风险 |
| --- | --- | --- |
| P0 | 补 file_read 分页;approve 复用 ingest;create_task 复用 customer-resolve;提示词补"无命中引导沉淀" | 低 |
| P1 | 业务工具合并(customer_query/conversation_query/knowledge_candidate/task_manage/insight_query);前端能力清单同步 | 中 |
| P2 | todo_list 持久化或边界明确;幽灵工具按计划补实现 | 中 |
| P3 | 工具使用统计 + 高频榜单 + 经验自动沉淀 | 低(新功能) |