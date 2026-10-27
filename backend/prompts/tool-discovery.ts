/**
 * 工具编目三层调用(search_tools / get_tool_details / call_tool)的工具描述文案。
 *
 * 这三段文字会直接进模型上下文(作为 tools 定义里的 description),所以归到 prompts/ 统一管理:
 * 调文案只改这里,不用碰 backend/mcp/tool-discovery.ts 的检索/执行逻辑。
 */

export interface ToolDiscoveryPromptOptions {
	/** 当前编目里的工具总数 */
	catalogSize: number;
	/** search_tools 默认返回条数 */
	topK: number;
	/** 单次运行 get_tool_details 的调用上限 */
	maxInspect: number;
}

/** 编目层:只给"工具名 + 一行描述",让模型知道有哪些工具可选。 */
export function getSearchToolsPrompt(options: ToolDiscoveryPromptOptions): string {
	return `按需求检索可用工具清单(名称 + 一行描述,不含参数定义);命中后请用 get_tool_details 取该工具的完整参数,再用 call_tool 执行。当前编目共 ${options.catalogSize} 个工具。

检索是「关键词词面 + 语义」双通道,所以 query 的写法直接决定命中率:
1) **先把用户的中文需求翻成英文,再用英文写 query**(工具名与工具描述全部是英文,含工作流),例如 "list pull requests"、"search knowledge base for policy"、"customer follow-up review workflow",而不要写「列出 PR」——中文动作词在英文工具描述里没有对应词,检索会失效;
2) 一句话说清"动作 + 对象"(动词 + 名词),比只写一个名词更容易命中;
3) 要调已沉淀的工作流,query 里务必带上 "workflow" 这个词(如 "customer follow-up review workflow"):工作流的中文名只给界面看,模型侧只按英文描述索引,实测只写业务词会落到 PR review 这类工具上;
4) 一次没命中就换个说法再检索(把中文换成英文动词、补上工具名/描述里可能出现的关键词),不要用同一个问法反复检索。`;
}

/** 检查层:只给这一个工具的完整参数 schema,把上下文占用压到最小。 */
export function getToolDetailsPrompt(options: ToolDiscoveryPromptOptions): string {
	return `取指定工具的完整参数定义(仅返回该工具,才把参数 schema 放进上下文)。单次运行最多调用 ${options.maxInspect} 次。`;
}

/** 执行层:名字必须与编目里完全一致,防止模型编造工具名。 */
export function getCallToolPrompt(): string {
	return "执行一个已通过 get_tool_details 了解参数的工具。name 必须是编目里的确切工具名,arguments 按该工具的参数定义填。";
}

/**
 * 双语 query 改写提示词:把用户的一句中文(或英文)需求改写成 {"zh","en"} 两条检索词。
 *   zh 用来召回"中文描述的工具"(工作流、中文业务工具);
 *   en 用来召回"英文描述的工具"(本地工具、外部 MCP 工具)。
 * 两条 query 各走一路召回再融合,所以模型不需要猜"这个工具是什么语言写的"。
 */
export function getQueryRewritePrompt(input: { goal: string; toolCount: number }): string {
	return `你是工具检索的查询改写器。本轮可用工具共 ${input.toolCount} 个,其中一部分工具的描述是中文(如工作流),一部分是英文(如本地业务工具、外部 MCP 工具)。

用户需求:${input.goal}

请把它改写成两条检索词,只输出一个 \`\`\`json 代码块:
{
  "zh": "中文检索词",
  "en": "English search keywords"
}

要求:
- 两边说的是同一件事:zh 只用来检索中文描述的工具,en 只用来检索英文描述的工具;
- 每条都是一句"动作 + 对象"的检索词(5-15 个词),不要解释、不要补充用户没说的信息,不要写成句子;
- en 要带上英文工具描述里可能出现的词(动词如 list/create/merge/rerun,名词如 pull request/branch/workflow/commit);
- 业务名词按语义对应翻译(客户→customer、会话→conversation、话术→sales script、竞品→competitor、跟进→follow-up、周报→weekly report);
- 如果用户本来就是英文提问,zh 仍要给一条等价的中文检索词。
- 如果这句话根本不需要工具(打招呼、闲聊、感谢、问你是谁、让你继续),两条都写空字符串:{"zh":"","en":""} ——
  表示"本轮不用召回工具";不要硬凑检索词(实测硬凑会让模型拿到一堆靠泛词命中的无关工具)。
不要输出其他内容。`;
}