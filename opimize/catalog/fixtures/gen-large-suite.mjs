/**
 * 生成"干净基准"语料:100 个英文 MCP 工具 + 100 个中文工作流 + 每个工具 3 种问法(直白/口语/同义改写)。
 *
 * 每个工具 3 种问法,用来把"字面命中"和"改写命中"分开看:
 *   literal  直接用工具名/描述里的词(考词面通道)
 *   casual   口语说法(考"动作+对象"这种日常表达)
 *   synonym  换同义词、不复用工具里的动词/名词(考语义通道,也是最接近真实用户说话的形态)
 * 每组用例都同时给 zh(用户原话)与 en(改写产物),分别进中文池 / 英文池。
 *
 * 用法: npx tsx opimize/catalog/fixtures/gen-large-suite.mjs
 * 产出: mcp-en-100.json / workflow-zh-100.json / cases-600.json
 */
import { writeFileSync } from "node:fs";

/** 英文 MCP:10 个动作 × 10 个对象 = 100 个工具;每种动作给 3 种英文说法 */
const MCP_VERBS = [
	{
		en: "list", zh: "列出",
		desc: (p) => `List ${p} available in the Acme workspace`,
		styles: { literal: (p) => `list ${p}`, casual: (p) => `show me all the ${p}`, synonym: (p) => `pull up everything under ${p}` },
	},
	{
		en: "get", zh: "查看",
		desc: (_p, o) => `Get details of a ${o} by id`,
		styles: { literal: (_p, o) => `get ${o}`, casual: (_p, o) => `pull up one ${o}`, synonym: (_p, o) => `look into a single ${o}` },
	},
	{
		en: "create", zh: "创建",
		desc: (_p, o) => `Create a new ${o}`,
		styles: { literal: (_p, o) => `create a ${o}`, casual: (_p, o) => `open a new ${o}`, synonym: (_p, o) => `start a fresh ${o}` },
	},
	{
		en: "update", zh: "更新",
		desc: (_p, o) => `Update fields of an existing ${o}`,
		styles: { literal: (_p, o) => `update ${o}`, casual: (_p, o) => `change something on an existing ${o}`, synonym: (_p, o) => `edit the fields of a ${o}` },
	},
	{
		en: "delete", zh: "删除",
		desc: (_p, o) => `Delete a ${o} permanently`,
		styles: { literal: (_p, o) => `delete ${o}`, casual: (_p, o) => `wipe a ${o} out for good`, synonym: (_p, o) => `get rid of a ${o} completely` },
	},
	{
		en: "search", zh: "搜索",
		desc: (p) => `Search ${p} by keyword`,
		styles: { literal: (p) => `search ${p}`, casual: (p) => `find ${p} that match a keyword`, synonym: (p) => `look through ${p} for a word` },
	},
	{
		en: "archive", zh: "归档",
		desc: (_p, o) => `Archive a ${o} so it stops appearing in active lists`,
		styles: { literal: (_p, o) => `archive a ${o}`, casual: (_p, o) => `put a ${o} away so it leaves the active list`, synonym: (_p, o) => `set a ${o} aside, no longer in use` },
	},
	{
		en: "restore", zh: "恢复",
		desc: (_p, o) => `Restore an archived ${o}`,
		styles: { literal: (_p, o) => `restore a ${o}`, casual: (_p, o) => `bring a ${o} back`, synonym: (_p, o) => `put a ${o} back in use again` },
	},
	{
		en: "export", zh: "导出",
		desc: (_p, o) => `Export a ${o} as a downloadable file`,
		styles: { literal: (_p, o) => `export a ${o}`, casual: (_p, o) => `save a ${o} to a file`, synonym: (_p, o) => `give me a downloadable dump of a ${o}` },
	},
	{
		en: "duplicate", zh: "复制",
		desc: (_p, o) => `Duplicate a ${o} into another workspace, keeping its metadata`,
		styles: { literal: (_p, o) => `duplicate a ${o}`, casual: (_p, o) => `copy a ${o} somewhere else`, synonym: (_p, o) => `make a second copy of a ${o} in another space` },
	},
];
/** 对象:zh 是中文说法,synonym 用更口语的别名 */
const MCP_DOMAINS = [
	{ singular: "repository", plural: "repositories", zh: "仓库", alias: "repo", note: "Works across every branch and tag." },
	{ singular: "issue", plural: "issues", zh: "问题单", alias: "ticket", note: "Keeps labels, assignees and milestone." },
	{ singular: "pull request", plural: "pull requests", zh: "拉取请求", alias: "PR", note: "Reports review state and CI checks." },
	{ singular: "release", plural: "releases", zh: "发布版本", alias: "published version", note: "Includes the git tag and release notes." },
	{ singular: "workflow run", plural: "workflow runs", zh: "流水线运行", alias: "pipeline run", note: "Returns run status and step logs." },
	{ singular: "package", plural: "packages", zh: "构建产物", alias: "build artifact", note: "Covers container and npm packages." },
	{ singular: "secret", plural: "secrets", zh: "密钥", alias: "credential", note: "Scoped to a repository or the whole organization." },
	{ singular: "team", plural: "teams", zh: "团队", alias: "user group", note: "Returns members and their roles." },
	{ singular: "project board", plural: "project boards", zh: "项目看板", alias: "board", note: "Returns columns and cards." },
	{ singular: "gist", plural: "gists", zh: "代码片段", alias: "snippet", note: "Returns files and revision history." },
];

/** 中文工作流:10 个动作 × 10 个业务对象 = 100 个;每种动作给 3 种中文说法 + 英文改写 */
const WF_ACTIONS = [
	{ name: "复盘", en: "review", outcome: "输出一份复盘结论", styles: { literal: (d) => `跑一下${d}复盘`, casual: (d) => `把${d}最近的情况过一遍`, synonym: (d) => `回顾一下${d}的情况` }, enPhrase: (d) => `run the ${d} review workflow` },
	{ name: "汇总", en: "summary", outcome: "产出一份可发群的汇总", styles: { literal: (d) => `${d}汇总跑一遍`, casual: (d) => `把${d}整理成一份汇总`, synonym: (d) => `出一份${d}的统计报告` }, enPhrase: (d) => `generate the ${d} summary workflow` },
	{ name: "预警", en: "alert", outcome: "给出需要预警的清单", styles: { literal: (d) => `${d}预警跑一下`, casual: (d) => `看看${d}有没有要提醒的`, synonym: (d) => `给${d}做个风险提示` }, enPhrase: (d) => `run the ${d} alert workflow` },
	{ name: "对比", en: "comparison", outcome: "输出差异清单", styles: { literal: (d) => `${d}对比跑一下`, casual: (d) => `把${d}和我们自己的比一比`, synonym: (d) => `做个${d}的差异分析` }, enPhrase: (d) => `run the ${d} comparison workflow` },
	{ name: "归档", en: "archive", outcome: "把过期内容归档", styles: { literal: (d) => `${d}归档`, casual: (d) => `把${d}收进归档`, synonym: (d) => `让${d}下线,不再使用` }, enPhrase: (d) => `run the ${d} archive workflow` },
	{ name: "质检", en: "quality check", outcome: "输出质检问题清单", styles: { literal: (d) => `${d}质检跑一遍`, casual: (d) => `检查一下${d}合不合规`, synonym: (d) => `给${d}做一次合规自查` }, enPhrase: (d) => `run the ${d} quality check workflow` },
	{ name: "跟进", en: "follow-up", outcome: "生成跟进待办", styles: { literal: (d) => `${d}跟进安排一下`, casual: (d) => `给${d}安排下一步动作`, synonym: (d) => `为${d}排一个后续计划` }, enPhrase: (d) => `run the ${d} follow-up workflow` },
	{ name: "清理", en: "cleanup", outcome: "清理重复与失效内容", styles: { literal: (d) => `${d}清理一下`, casual: (d) => `把${d}里的重复内容清掉`, synonym: (d) => `整理${d},删掉重复与失效的` }, enPhrase: (d) => `run the ${d} cleanup workflow` },
	{ name: "拉取", en: "extract", outcome: "拉取明细数据", styles: { literal: (d) => `${d}明细拉一下`, casual: (d) => `把${d}的明细拉出来`, synonym: (d) => `取一份${d}的数据` }, enPhrase: (d) => `run the ${d} extract workflow` },
	{ name: "打分", en: "scoring", outcome: "输出评分结果", styles: { literal: (d) => `${d}打个分`, casual: (d) => `给${d}评个分`, synonym: (d) => `对${d}做个质量评分` }, enPhrase: (d) => `run the ${d} scoring workflow` },
];
const WF_DOMAINS = [
	{ zh: "客户", en: "customer", body: "读取客户档案与最近会话" },
	{ zh: "会话", en: "conversation", body: "读取最近的通话与会话原文" },
	{ zh: "话术", en: "sales script", body: "检索知识库里的标准话术" },
	{ zh: "待办", en: "task", body: "读取当前跟进待办" },
	{ zh: "知识库", en: "knowledge base", body: "检索团队知识库" },
	{ zh: "成交", en: "deal", body: "读取成交与折扣明细" },
	{ zh: "门店", en: "store", body: "读取门店经营数据" },
	{ zh: "竞品", en: "competitor", body: "检索竞品资料" },
	{ zh: "报价", en: "quote", body: "读取历史报价与政策" },
	{ zh: "周报", en: "weekly report", body: "按周统计经营与跟进情况" },
];
const LOCAL_STEPS = ["conversation_query", "customer_query", "task_manage", "knowledge_search", "playbook_check", "sql", "chart_generate", "insight_query", "keyword_extract_free", "table_generate"];
const STYLES = ["literal", "casual", "synonym"];

const mcpTools = [];
for (const domain of MCP_DOMAINS) {
	for (const verb of MCP_VERBS) {
		const plural = verb.en === "list";
		const noun = plural ? domain.plural : domain.singular;
		const name = `mcp_acme_${verb.en}_${(plural ? domain.plural : domain.singular).replace(/ /g, "_")}`;
		mcpTools.push({
			name,
			description: `${verb.desc(domain.plural, domain.singular)}. ${domain.note}`,
			inputSchema: { type: "object", properties: { id: { type: "string", description: `${domain.singular} id` }, page: { type: "number", description: "page number" } } },
			zhObject: domain.zh,
			enObject: noun,
			zhAlias: domain.alias,
			cases: Object.fromEntries(STYLES.map((style) => [style, { en: verb.styles[style](domain.plural, domain.singular), zh: `${verb.zh}${domain.zh}` }])),
		});
	}
}

const workflows = [];
for (const domain of WF_DOMAINS) {
	for (const action of WF_ACTIONS) {
		const name = `${domain.zh}${action.name}`;
		const steps = [LOCAL_STEPS[(domain.zh.length + action.name.length) % LOCAL_STEPS.length], LOCAL_STEPS[(domain.zh.length + action.name.length + 3) % LOCAL_STEPS.length]];
		workflows.push({
			name: `workflow_${domain.en.replace(/ /g, "_")}_${action.en.replace(/ /g, "_")}`,
			label: `工作流:${name}`,
			description: `执行已沉淀的工作流「${name}」:${domain.body},${action.outcome}。可传参数:${domain.en.replace(/ /g, "")}Key/days。`,
			steps: [...new Set(steps)].map((tool) => ({ name: tool, tool, params: {} })),
			cases: Object.fromEntries(STYLES.map((style) => [style, { zh: action.styles[style](domain.zh), en: action.enPhrase(domain.en) }])),
		});
	}
}

const cases = [];
const pushCases = (group, tools) => {
	tools.forEach((tool, index) => {
		for (const style of STYLES) {
			const variant = tool.cases[style];
			cases.push({ id: `${group === "mcp" ? "mcp" : "wf"}-${String(index + 1).padStart(3, "0")}-${style}`, group, style, zh: variant.zh, en: variant.en, expect: tool.name });
		}
	});
};
pushCases("mcp", mcpTools);
pushCases("workflow", workflows);

const strip = (rows, keys) => rows.map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k))));
const dir = new URL("./", import.meta.url);
writeFileSync(new URL("mcp-en-100.json", dir), JSON.stringify(strip(mcpTools, ["cases", "zhObject", "enObject", "zhAlias"]), null, 2), "utf8");
writeFileSync(new URL("workflow-zh-100.json", dir), JSON.stringify(strip(workflows, ["cases"]), null, 2), "utf8");
writeFileSync(new URL("cases-600.json", dir), JSON.stringify(cases, null, 2), "utf8");
console.log(`已生成:英文 MCP ${mcpTools.length} 个 / 中文工作流 ${workflows.length} 个 / 用例 ${cases.length} 条(每工具 ${STYLES.length} 种问法 × 中英两侧 query)`);
