import { describe, expect, it } from "vitest";
import { ToolRetriever, rrf, tokenize } from "./retrieval.js";

/**
 * 双通道检索单测:这里只验"通道机制"(分词/词边界/语义下限/融合排名),
 * 真实 BGE 语义效果不靠单测,由离线评测 opimize/catalog 打分。
 * 语义通道用可编程替身(概念向量),避免单测依赖模型文件与 worker 线程。
 */
const GROUPS: string[][] = [
	["工作流", "流程", "固化", "套路", "复用", "沉淀"],
	["图表", "画图", "饼图", "chart"],
];

/** 概念向量替身:命中第 i 组概念就在第 i 维置 1;一组都不命中给零向量(余弦 0,必被下限挡掉)。 */
function conceptEmbed(texts: string[]): Promise<number[][]> {
	return Promise.resolve(
		texts.map((text) => {
			const t = String(text ?? "");
			const vec = GROUPS.map(() => 0);
			GROUPS.forEach((words, i) => {
				if (words.some((w) => t.includes(w))) vec[i] = 1;
			});
			return vec;
		}),
	);
}

const DOCS = [
	{ name: "workflow_manage", label: "工作流沉淀", description: "从历史运行挖掘高频工具串联并生成待审批草稿" },
	{ name: "chart_generate", label: "生成统计图", description: "生成 ECharts 图表,前端统一渲染" },
];

function retriever(semanticFloor = 0.5): ToolRetriever {
	return new ToolRetriever(DOCS, { semanticFloors: { zh: semanticFloor, en: semanticFloor }, embed: conceptEmbed });
}

describe("工具检索:分词", () => {
	it("英文按词边界整词取词,短词与停用词丢掉(而不是裸子串)", () => {
		expect(tokenize("what date is today?")).toEqual(["date", "today"]);
		// "issue" 里的 "is" 不会被单独切出来 —— 这正是"创建issue"命中 issue 却不该被 is 误伤的原因
		expect(tokenize("创建issue").sort()).toEqual(["issue", "创建"]);
	});

	it("中文切二元组,并过滤中文停用词", () => {
		const tokens = tokenize("帮我看看客户情况");
		expect(tokens).toContain("客户");
		expect(tokens).not.toContain("帮我");
	});
});

describe("工具检索:词面通道", () => {
	it("短词不会跨词命中(what date is today? 不该捞出 update_issue)", () => {
		const r = new ToolRetriever(
			[
				{ name: "mcp_github_update_issue", description: "Update an existing issue" },
				{ name: "date_tool", label: "日期转换", description: "把对话中的相对日期转换为具体日期" },
			],
			{ semanticFloors: { zh: 0.5, en: 0.6 }, embed: conceptEmbed },
		);
		expect(r.searchLexical("what date is today?", 5)).toEqual(["date_tool"]);
	});

	it("英文单复数归一:问 branch 也能命中 list_branches", () => {
		const r = new ToolRetriever(
			[
				{ name: "mcp_github_list_branches", description: "List branches in a GitHub repository" },
				{ name: "mcp_github_list_tags", description: "List git tags in a GitHub repository" },
			],
			{ semanticFloors: { zh: 0.5, en: 0.6 }, embed: conceptEmbed },
		);
		expect(tokenize("branches")).toEqual(["branch"]);
		expect(tokenize("releases")).toEqual(["release"]);
		expect(tokenize("class")).toEqual(["class"]);
		expect(r.searchLexical("仓库里有哪些 branch", 5)).toEqual(["mcp_github_list_branches"]);
	});

	it("名称/展示名里的词权重高于描述里的词", () => {
		const r = new ToolRetriever(
			[
				{ name: "task_manage", label: "跟进任务", description: "为客户创建跟进待办" },
				{ name: "customer_query", label: "客户查询", description: "查看客户档案与历史跟进" },
			],
			{ semanticFloors: { zh: 0.5, en: 0.6 }, embed: conceptEmbed },
		);
		const hits = r.searchLexical("跟进", 5);
		expect(hits[0]).toBe("task_manage");
		expect(hits).toContain("customer_query");
	});
});

describe("工具检索:语义通道与融合", () => {
	it("字面零重叠的改写查询靠语义通道捞回", async () => {
		const r = retriever();
		expect(r.searchLexical("把重复动作固定成套路", 5)).toEqual([]);
		expect(await r.searchSemantic("把重复动作固定成套路", 5)).toEqual(["workflow_manage"]);
		expect(await r.search("把重复动作固定成套路", 5)).toEqual(["workflow_manage"]);
	});

	it("语义下限挡住与任何工具都无关的闲聊查询", async () => {
		const r = retriever();
		expect(await r.searchSemantic("今天天气怎么样", 5)).toEqual([]);
		expect(await r.search("今天天气怎么样", 5)).toEqual([]);
		// 下限调成 0:同样的查询就会把零相关文档也捞出来(下限是唯一的挡板)
		const loose = retriever(0);
		expect((await loose.search("今天天气怎么样", 5)).length).toBeGreaterThan(0);
	});

	it("两路都命中的工具排在只有单路命中的前面", async () => {
		// 词面:alpha_tool 文档更短(长度归一化后排第 1),beta_tool 次之;
		// 语义:只认 beta(alpha 与查询余弦为 0,被下限挡掉)→ beta 在语义通道第 1。
		const embed = async (texts: string[]) => texts.map((text) => (String(text).includes("beta") ? [0, 1] : [1, 0]));
		const r = new ToolRetriever(
			[
				{ name: "alpha_tool", description: "alpha" },
				{ name: "beta_tool", description: "beta 用于处理很长的说明文本以便触发长度归一化惩罚和排名下沉" },
			],
			{ semanticFloors: { zh: 0.5, en: 0.6 }, embed },
		);
		expect(r.searchLexical("alpha beta", 5)).toEqual(["alpha_tool", "beta_tool"]);
		expect(await r.searchSemantic("alpha beta", 5)).toEqual(["beta_tool"]);
		// RRF:beta 被两路同时命中,累计得分超过只在词面出现的 alpha
		expect((await r.search("alpha beta", 5))[0]).toBe("beta_tool");
	});

	it("空查询返回空,交回上层提示「没有匹配的工具」", async () => {
		const r = retriever();
		expect(await r.search("   ", 5)).toEqual([]);
	});

	it("RRF 只看排名:单路并列时双路命中累加", () => {
		expect(rrf([["a"], ["b"]], 2)).toEqual(["a", "b"]);
		expect(rrf([["a"], ["a", "b"]], 2)).toEqual(["a", "b"]);
		expect(rrf([["a", "b"], ["b", "a"]], 2)).toEqual(["a", "b"]);
	});
});
describe("工具检索:按描述语言分池召回(中英工具混装的核心机制)", () => {
	const MIXED = [
		{ name: "workflow_wf_1", label: "工作流:客户跟进复盘", description: "执行已沉淀的工作流「客户跟进复盘」:读取客户最近会话并生成跟进待办", descriptionLanguage: "zh" as const },
		{ name: "mcp_github_list_pull_requests", description: "List pull requests in a GitHub repository", descriptionLanguage: "en" as const },
	];

	it("zh 那一路只召回中文描述的工具,en 那一路只召回英文描述的工具", async () => {
		const r = new ToolRetriever(MIXED, { semanticFloors: { zh: 0.5, en: 0.6 }, embed: conceptEmbed });
		expect(r.countByLanguage()).toEqual({ zh: 1, en: 1 });
		const zhHits = await r.search("这套客户跟进复盘再跑一遍", 5, "zh");
		expect(zhHits).toContain("workflow_wf_1");
		expect(zhHits).not.toContain("mcp_github_list_pull_requests");
		expect(await r.search("list pull requests", 5, "en")).toEqual(["mcp_github_list_pull_requests"]);
	});

	it("双语召回:两条 query 各自只召回同语言描述的工具,两段分开返回", async () => {
		const r = new ToolRetriever(MIXED, { semanticFloors: { zh: 0.5, en: 0.6 }, embed: conceptEmbed });
		const grouped = await r.searchGrouped({ zh: "这套客户跟进复盘再跑一遍", en: "list pull requests" }, { perLanguageTopK: 8 });
		expect(grouped.zh).toEqual(["workflow_wf_1"]); // 中文那一段只有中文描述的工作流
		expect(grouped.en).toEqual(["mcp_github_list_pull_requests"]); // 英文那一段只有英文描述的工具
	});

	it("模型自己那次 search_tools 的 query 按语言并入对应那一段(改写之外还有修正机会)", async () => {
		const r = new ToolRetriever(MIXED, { semanticFloors: { zh: 0.5, en: 0.6 }, embed: conceptEmbed });
		// 改写两条都为空(模型判定"这句不用工具"),但模型自己给了一条英文 query → 英文那一段仍要召回
		const grouped = await r.searchGrouped({ zh: "", en: "" }, { perLanguageTopK: 8 }, "list pull requests");
		expect(grouped.en).toEqual(["mcp_github_list_pull_requests"]);
		expect(grouped.zh).toEqual([]);
	});

	it("某一语言没有工具 / query 为空时,那一段就是空数组", async () => {
		const onlyEn = new ToolRetriever([MIXED[1]], { semanticFloors: { zh: 0.5, en: 0.6 }, embed: conceptEmbed });
		const grouped = await onlyEn.searchGrouped({ zh: "客户跟进复盘", en: "list pull requests" }, { perLanguageTopK: 8 });
		expect(grouped.zh).toEqual([]); // 没有中文工具
		expect(grouped.en).toEqual(["mcp_github_list_pull_requests"]);
		const empty = await onlyEn.searchGrouped({ zh: "客户跟进复盘", en: "   " }, { perLanguageTopK: 8 });
		expect(empty).toEqual({ zh: [], en: [] });
	});
	it("描述语言缺省时按文本推断(含中文即 zh)", () => {
		const inferred = new ToolRetriever([{ name: "wf_zh", description: "执行已沉淀的工作流" }, { name: "wf_en", description: "Execute the saved workflow" }], { semanticFloors: { zh: 0.5, en: 0.6 }, embed: conceptEmbed });
		expect(inferred.countByLanguage()).toEqual({ zh: 1, en: 1 });
	});
});