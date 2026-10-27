/**
 * 工具检索评测集:模型的真实问句 → 应命中的工具(可接受集合)。
 *
 * 五类用例,分别压不同的能力:
 *   local     本地目录工具,中文口语化提问(常驻直挂那一批,用来验证"工具多了会不会互相打架")
 *   mcp       外部 MCP 工具,纯中文提问(GitHub 46 个工具,描述全是英文 —— 最难的跨语言一档)
 *   mixed     同一批 MCP 工具,中英混写提问(带 pull request / merge / review 这类工具里的词)
 *   rewrite   改写问句:字面跟工具名/描述几乎没有重叠,只有语义通道能捞回来
 *   chitchat  与任何工具都无关的闲聊/无关查询,正确答案是"没有匹配的工具"(只用来量误召回)
 *
 * expect 是"可接受集合",不是单一名次:命中集合里任意一个都算对(例如"读文件"既可给 txt 也可给 file_read)。
 * 允许集合为空表示该问句本就不该命中任何工具。
 * 一条用例算不算数,由评测脚本按"该语料里是否真的存在被期望的工具"来判定(见 run-eval.ts 的 applicableCases)。
 */
export type EvalKind = "local" | "mcp" | "mixed" | "rewrite" | "en" | "chitchat";

export interface EvalCase {
	id: string;
	query: string;
	/** 可接受的目标工具名(空数组 = 不该命中任何工具) */
	expect: string[];
	/** 模型对该问题的中文改写(query 改写步骤的产物):双语召回时 zh 那一路用它;中文问题的用例缺省就是 query */
	queryZh?: string;
	/** 模型对该问题的英文改写(query 改写步骤的产物):双语召回时 en 那一路用它;英文问题的用例缺省就是 query */
	queryEn?: string;
	kind: EvalKind;
}

const LOCAL_CASES: EvalCase[] = [
	{ id: "local-01", query: "把最近的会话记录调出来看看", expect: ["conversation_query"], kind: "local", queryEn: "list the recent conversations", queryZh: "把最近的会话记录调出来看看" },
	{ id: "local-02", query: "打开这个客户的档案", expect: ["customer_query"], kind: "local", queryEn: "open this customer's profile" },
	{ id: "local-03", query: "生成今天的晨报", expect: ["insight_query"], kind: "local", queryEn: "generate today''s morning briefing" },
	{ id: "local-04", query: "看看最近 30 天的经营趋势", expect: ["insight_query"], kind: "local", queryEn: "show the business trend for the last 30 days" },
	{ id: "local-05", query: "有哪些待确认的沉淀候选?", expect: ["knowledge_candidate"], kind: "local", queryEn: "list the pending knowledge candidates" },
	{ id: "local-06", query: "把这段话术沉淀进知识库", expect: ["knowledge_ingest"], kind: "local", queryEn: "save this sales script into the knowledge base", queryZh: "把这段话术沉淀进知识库" },
	{ id: "local-07", query: "查一下分期付款政策是怎么写的", expect: ["knowledge_search"], kind: "local", queryEn: "search the knowledge base for the installment policy", queryZh: "查一下分期付款政策是怎么写的" },
	{ id: "local-08", query: "看看这次通话销售有没有说到标准话术", expect: ["playbook_check"], kind: "local", queryEn: "check whether the sales script was used in this call" },
	{ id: "local-09", query: "给这个客户建一条下周的跟进待办", expect: ["task_manage"], kind: "local", queryEn: "create a follow-up task for this customer", queryZh: "给这个客户建一条下周的跟进待办" },
	{ id: "local-10", query: "把最近重复的操作固化成一个工作流", expect: ["workflow_manage"], kind: "local", queryEn: "mine the recent repeated steps into a reusable workflow", queryZh: "把最近重复的操作固化成一个工作流" },
	{ id: "local-11", query: "抓取一下这个网页的正文", expect: ["browser"], kind: "local", queryEn: "fetch the text of this web page", queryZh: "抓取一下这个网页的正文" },
	{ id: "local-12", query: "把这些评论按话题自动分组", expect: ["cluster"], kind: "local", queryEn: "group these comments by topic" },
	{ id: "local-13", query: "算一下 (12+8)*3 等于多少", expect: ["computer"], kind: "local", queryEn: "calculate (12+8)*3" },
	{ id: "local-14", query: "what date is today?", expect: ["date_tool"], kind: "local", queryZh: "今天是几号?" },
	{ id: "local-15", query: "从这次会话里把提到价格的句子抽出来", expect: ["dialog_extract"], kind: "local", queryEn: "extract the sentences that mention price from this conversation" },
	{ id: "local-16", query: "把这段话转成向量", expect: ["embedding"], kind: "local", queryEn: "turn this text into an embedding vector" },
	{ id: "local-17", query: "读一下这个 Excel 表格", expect: ["excel"], kind: "local", queryEn: "read this Excel spreadsheet", queryZh: "读一下这个 Excel 表格" },
	{ id: "local-18", query: "新建一个说明文件,把结论写进去", expect: ["file_write_new"], kind: "local", queryEn: "create a new file and write the conclusion into it" },
	{ id: "local-19", query: "在看板上加一个任务卡片", expect: ["kanban"], kind: "local", queryEn: "add a task card on the kanban board" },
	{ id: "local-20", query: "从这段对话里抽几个关键词当标签", expect: ["keyword_extract_free"], kind: "local", queryEn: "extract keywords from this conversation as tags" },
	{ id: "local-21", query: "这段文本里有没有命中这些候选标签", expect: ["keyword_extract_strict"], kind: "local", queryEn: "check whether these candidate tags appear in the text" },
	{ id: "local-22", query: "读一下这个 PPT 的内容", expect: ["ppt"], kind: "local", queryEn: "read this PPT deck" },
	{ id: "local-23", query: "往 redis 里写一个缓存值", expect: ["redis"], kind: "local", queryEn: "write a cached value into redis" },
	{ id: "local-24", query: "比较这两句话的相似度", expect: ["similarity"], kind: "local", queryEn: "compare the similarity of these two sentences", queryZh: "比较这两句话的相似度" },
	{ id: "local-25", query: "查一下数据库里上个月的成交记录", expect: ["sql"], kind: "local", queryEn: "query last month''s deal records from the database" },
	{ id: "local-26", query: "把这个任务拆给子代理并行处理", expect: ["subagents"], kind: "local", queryEn: "split this task to subagents and run them in parallel" },
	{ id: "local-27", query: "把这堆数据生成一张表格", expect: ["table_generate"], kind: "local", queryEn: "turn this data into a table" },
	{ id: "local-28", query: "在这台机器上执行一条命令", expect: ["terminal"], kind: "local", queryEn: "run a command on this machine", queryZh: "在这台机器上执行一条命令" },
	{ id: "local-29", query: "读一下仓库里的 README", expect: ["txt", "file_read"], kind: "local", queryEn: "read the README in the repository" },
	{ id: "local-30", query: "帮我记住以后回复都简洁一点", expect: ["update_memory"], kind: "local", queryEn: "remember that my replies should be concise from now on" },
	{ id: "local-31", query: "搜一下新能源汽车最新补贴政策", expect: ["web_search"], kind: "local", queryEn: "search the web for the latest subsidy policy", queryZh: "搜一下新能源汽车最新补贴政策" },
	{ id: "local-32", query: "画一张近半年销量的柱状图", expect: ["chart_generate"], kind: "local", queryEn: "draw a bar chart of sales over the last six months" },
];

const MCP_CASES: EvalCase[] = [
	{ id: "mcp-01", query: "帮我建一个分支", expect: ["mcp_github_create_branch"], kind: "mcp", queryEn: "create a branch" },
	{ id: "mcp-02", query: "创建一个 issue", expect: ["mcp_github_issue_write"], kind: "mcp", queryEn: "create an issue", queryZh: "创建一个 issue" },
	{ id: "mcp-03", query: "提一个 pull request", expect: ["mcp_github_create_pull_request"], kind: "mcp", queryEn: "create a pull request", queryZh: "提一个 pull request" },
	{ id: "mcp-04", query: "列出这个仓库的 PR", expect: ["mcp_github_list_pull_requests"], kind: "mcp", queryEn: "list the pull requests in this repository", queryZh: "列出这个仓库的 PR" },
	{ id: "mcp-05", query: "在 GitHub 上找一个类似的开源项目", expect: ["mcp_github_search_repositories"], kind: "mcp", queryEn: "search GitHub for a similar open source repository", queryZh: "在 GitHub 上找一个类似的开源项目" },
	{ id: "mcp-06", query: "把这个 PR 合并掉", expect: ["mcp_github_merge_pull_request"], kind: "mcp", queryEn: "merge this pull request", queryZh: "把这个 PR 合并掉" },
	{ id: "mcp-07", query: "看看仓库里这个文件的内容", expect: ["mcp_github_get_file_contents"], kind: "mcp", queryEn: "get the contents of this file in the repository", queryZh: "看看仓库里这个文件的内容" },
	{ id: "mcp-08", query: "查看这个 PR 的详情", expect: ["mcp_github_pull_request_read"], kind: "mcp", queryEn: "read the details of this pull request", queryZh: "查看这个 PR 的详情" },
	{ id: "mcp-09", query: "列出所有 release", expect: ["mcp_github_list_releases"], kind: "mcp", queryEn: "list all releases" },
	{ id: "mcp-10", query: "把这个仓库 fork 到我的账号", expect: ["mcp_github_fork_repository"], kind: "mcp", queryEn: "fork this repository to my account" },
	{ id: "mcp-11", query: "查看我 GitHub 账号的信息", expect: ["mcp_github_get_me"], kind: "mcp", queryEn: "get my GitHub account information" },
	{ id: "mcp-12", query: "给这个 issue 加一条评论", expect: ["mcp_github_add_issue_comment"], kind: "mcp", queryEn: "add a comment to this issue" },
	{ id: "mcp-13", query: "搜索代码里用到 createSalesAgentTools 的地方", expect: ["mcp_github_search_code"], kind: "mcp", queryEn: "search the code for createSalesAgentTools", queryZh: "搜索代码里用到 createSalesAgentTools 的地方" },
	{ id: "mcp-14", query: "给这个 PR 做一次代码评审", expect: ["mcp_github_pull_request_review_write", "mcp_github_request_copilot_review"], kind: "mcp", queryEn: "review this pull request" },
	{ id: "mcp-15", query: "扫描一下有没有泄露的密钥", expect: ["mcp_github_run_secret_scanning"], kind: "mcp", queryEn: "scan for leaked secrets" },
	{ id: "mcp-16", query: "看看最近的提交记录", expect: ["mcp_github_list_commits"], kind: "mcp", queryEn: "list the recent commits", queryZh: "看看最近的提交记录" },
	{ id: "mcp-17", query: "仓库里有哪些分支", expect: ["mcp_github_list_branches"], kind: "mcp", queryEn: "list the branches in this repository", queryZh: "仓库里有哪些分支" },
	{ id: "mcp-18", query: "update the pull request description", expect: ["mcp_github_update_pull_request"], kind: "mcp", queryZh: "更新这个 pull request 的描述" },
	{ id: "mcp-19", query: "按标签筛选一下 issue 列表", expect: ["mcp_github_list_issues"], kind: "mcp", queryEn: "list issues filtered by label", queryZh: "按标签筛选一下 issue 列表" },
	{ id: "mcp-20", query: "找一个 GitHub 用户", expect: ["mcp_github_search_users"], kind: "mcp", queryEn: "find a GitHub user" },
];

/** 同一批 MCP 工具,但提问里带上工具描述里真实出现过的英文关键词(模拟"模型按工具语言提问") */
const MIXED_CASES: EvalCase[] = [
	{ id: "mix-01", query: "列出这个仓库的 pull request", expect: ["mcp_github_list_pull_requests"], kind: "mixed", queryEn: "list the pull requests in this repository", queryZh: "列出这个仓库的 pull request" },
	{ id: "mix-02", query: "把这个 pull request merge 掉", expect: ["mcp_github_merge_pull_request"], kind: "mixed", queryEn: "merge this pull request", queryZh: "把这个 pull request merge 掉" },
	{ id: "mix-03", query: "查看这个 issue 的内容", expect: ["mcp_github_issue_read"], kind: "mixed", queryEn: "read this issue", queryZh: "查看这个 issue 的内容" },
	{ id: "mix-04", query: "给这个 pull request 提 review 意见", expect: ["mcp_github_pull_request_review_write", "mcp_github_request_copilot_review"], kind: "mixed", queryEn: "review this pull request", queryZh: "给这个 pull request 提 review 意见" },
	{ id: "mix-05", query: "看看最近的 commit 记录", expect: ["mcp_github_list_commits"], kind: "mixed", queryEn: "list the recent commits" },
	{ id: "mix-06", query: "仓库里有哪些 branch", expect: ["mcp_github_list_branches"], kind: "mixed", queryEn: "list the branches in this repository" },
	{ id: "mix-07", query: "搜一下 GitHub 上的 repository", expect: ["mcp_github_search_repositories"], kind: "mixed", queryEn: "search GitHub for a repository" },
	{ id: "mix-08", query: "把这个 pull request 的 branch 更新一下", expect: ["mcp_github_update_pull_request_branch"], kind: "mixed", queryEn: "update the branch of this pull request" },
];

const REWRITE_CASES: EvalCase[] = [
	{ id: "rw-01", query: "把重复动作固定成套路,以后照着做", expect: ["workflow_manage"], kind: "rewrite", queryEn: "turn this repeated action into a reusable workflow", queryZh: "把重复动作固定成套路,以后照着做" },
	{ id: "rw-02", query: "我需要一份今天整体情况的简报", expect: ["insight_query"], kind: "rewrite", queryEn: "give me a briefing of today''s overall situation" },
	{ id: "rw-03", query: "这段话以后别人也要能用,帮我存起来", expect: ["knowledge_ingest"], kind: "rewrite", queryEn: "save this text so others can reuse it later" },
	{ id: "rw-04", query: "客户老是没人管,给我生成点提醒", expect: ["task_manage"], kind: "rewrite", queryEn: "customers are not being followed up, create some reminders" },
	{ id: "rw-05", query: "谁最近买了车,我想看下清单", expect: ["sql", "customer_query"], kind: "rewrite", queryEn: "list the customers who bought a car recently", queryZh: "谁最近买了车,我想看下清单" },
	{ id: "rw-06", query: "把这些数据变成好看的图形给人看", expect: ["chart_generate"], kind: "rewrite", queryEn: "turn this data into a nice chart" },
	{ id: "rw-07", query: "上周都聊了些什么,帮我回顾一下", expect: ["conversation_query"], kind: "rewrite", queryEn: "review what was discussed last week", queryZh: "上周都聊了些什么,帮我回顾一下" },
	{ id: "rw-08", query: "把这段发言和标准说法对一下,看差多少", expect: ["playbook_check"], kind: "rewrite", queryEn: "compare what was said with the standard script" },
	{ id: "rw-09", query: "帮我把这套客户跟进动作重复跑一遍", expect: ["workflow_wf_6741", "workflow_manage"], kind: "rewrite", queryEn: "rerun the customer follow-up review workflow", queryZh: "帮我把这套客户跟进动作重复跑一遍" },
	{ id: "rw-10", query: "把竞品的价格和我们的比一比", expect: ["workflow_wf_8802"], kind: "rewrite", queryEn: "compare competitor pricing with ours", queryZh: "把竞品的价格和我们的比一比" },
];

/**
 * 全英文问句:本地工具与 MCP 工具的元数据统一成英文之后,模拟"模型按工具语言提问"的情形。
 * 这批用例是"英文目录 + 英文查询"的上限表现,和 mcp 类(中文查询打英文工具)对照着看。
 */
const EN_CASES: EvalCase[] = [
	{ id: "en-01", query: "list the recent conversations", expect: ["conversation_query"], kind: "en", queryZh: "把最近的会话记录调出来看看" },
	{ id: "en-02", query: "show me this customer's profile and tags", expect: ["customer_query"], kind: "en", queryZh: "查看这个客户的档案和标签" },
	{ id: "en-03", query: "generate today''s morning briefing", expect: ["insight_query"], kind: "en", queryZh: "生成今天的晨报" },
	{ id: "en-04", query: "search the knowledge base for the installment policy", expect: ["knowledge_search"], kind: "en", queryZh: "查一下分期付款政策" },
	{ id: "en-05", query: "create a follow-up task for this customer", expect: ["task_manage"], kind: "en", queryZh: "给这个客户建一条跟进待办" },
	{ id: "en-06", query: "read this Excel spreadsheet", expect: ["excel", "file_read"], kind: "en", queryZh: "读一下这个 Excel 表格" },
	{ id: "en-07", query: "generate a bar chart of monthly sales", expect: ["chart_generate"], kind: "en", queryZh: "画一张月度销量的柱状图" },
	{ id: "en-08", query: "calculate (12+8)*3 for me", expect: ["computer"], kind: "en", queryZh: "算一下 (12+8)*3" },
	{ id: "en-09", query: "what date is today?", expect: ["date_tool"], kind: "en", queryZh: "今天是几号?" },
	{ id: "en-10", query: "hand this task over to a subagent and run it in parallel", expect: ["subagents"], kind: "en", queryZh: "把这个任务拆给子代理并行处理" },
	{ id: "en-11", query: "search the web for the latest subsidy policy", expect: ["web_search"], kind: "en", queryZh: "搜一下最新的补贴政策" },
	{ id: "en-12", query: "show the pending knowledge candidates and approve them", expect: ["knowledge_candidate"], kind: "en", queryZh: "看看待确认的沉淀候选" },
	{ id: "en-13", query: "list the pull requests in this repository", expect: ["mcp_github_list_pull_requests"], kind: "en", queryZh: "列出这个仓库的 PR" },
	{ id: "en-14", query: "create a branch for my fix", expect: ["mcp_github_create_branch"], kind: "en", queryZh: "帮我建一个分支" },
	{ id: "en-15", query: "merge this pull request", expect: ["mcp_github_merge_pull_request"], kind: "en", queryZh: "把这个 PR 合并掉" },
	{ id: "en-16", query: "show me the recent commits", expect: ["mcp_github_list_commits"], kind: "en", queryZh: "看看最近的提交记录" },
	{ id: "en-17", query: "list the branches of this repository", expect: ["mcp_github_list_branches"], kind: "en", queryZh: "仓库里有哪些分支" },
	{ id: "en-18", query: "search the code for createSalesAgentTools", expect: ["mcp_github_search_code"], kind: "en", queryZh: "搜索代码里用到 createSalesAgentTools 的地方" },
	{ id: "en-19", query: "scan the repo for leaked secrets", expect: ["mcp_github_run_secret_scanning"], kind: "en", queryZh: "扫描一下有没有泄露的密钥" },
	{ id: "en-20", query: "read the contents of this file in the repository", expect: ["mcp_github_get_file_contents", "file_read", "txt"], kind: "en", queryZh: "看看仓库里这个文件的内容" },
	{ id: "en-21", query: "rerun the customer follow-up review workflow", expect: ["workflow_wf_6741"], kind: "en", queryZh: "把客户跟进复盘再跑一遍" },
	{ id: "en-22", query: "compare competitor pricing with ours", expect: ["workflow_wf_8802"], kind: "en", queryZh: "把竞品的价格和我们的比一比" },
];

const CHITCHAT_CASES: EvalCase[] = [
	{ id: "chat-01", query: "你好", expect: [], kind: "chitchat", queryEn: "hello", queryZh: "你好" },
	{ id: "chat-02", query: "讲个笑话吧", expect: [], kind: "chitchat", queryEn: "tell me a joke", queryZh: "讲个笑话吧" },
	{ id: "chat-03", query: "帮我推荐一部电影", expect: [], kind: "chitchat", queryEn: "recommend a movie to me", queryZh: "帮我推荐一部电影" },
	{ id: "chat-04", query: "谢谢你,辛苦了", expect: [], kind: "chitchat", queryEn: "thanks for your help", queryZh: "谢谢你,辛苦了" },
	{ id: "chat-05", query: "你叫什么名字?", expect: [], kind: "chitchat", queryEn: "what is your name", queryZh: "你叫什么名字?" },
	{ id: "chat-06", query: "ok,继续说", expect: [], kind: "chitchat", queryEn: "ok, go on", queryZh: "ok,继续说" },
];

export const CASES: EvalCase[] = [...LOCAL_CASES, ...MCP_CASES, ...MIXED_CASES, ...REWRITE_CASES, ...EN_CASES, ...CHITCHAT_CASES];