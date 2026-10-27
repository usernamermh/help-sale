/**
 * 评测语料:把"模型实际能看到的一整套工具"落成固定语料,保证离线评测可复现、不依赖网络。
 *
 *   本地目录工具(tools / tools_system,32 个)       —— 生产里常驻直挂,这里一并放进来当"更难的一档"
 *   GitHub MCP 工具(fixtures/mcp-tools.json,46 个)  —— 编目模式的主要服务对象
 *   工作流工具(已晋升工作流,这里用 3 条样例)        —— 编目里的长尾之一
 *
 * 索引文本的构造直接复用生产检索模块(indexTextOf),不在这里另写一套,避免"评测和线上两套逻辑"。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { externalToolPaths, loadExternalAgentTools } from "../../backend/services/external-tools.ts";
import { paramNames, type RetrievalDoc } from "../../backend/mcp/retrieval.ts";

export interface ToolDoc extends RetrievalDoc {
	name: string;
	label: string;
	description: string;
	category: string;
	params: string[];
	source: "local" | "mcp" | "workflow";
}

/**
 * 已晋升工作流的样例:名称是 workflow_xxx 这种无语义 id,能说明用途的只有 label 与描述 ——
 * 正是最考验检索的一类长尾工具(生产里由 workflow_manage 的挖掘/审批链路产出)。
 */
const WORKFLOW_SAMPLES = [
	{
		name: "workflow_wf_6741",
		label: "工作流:客户跟进复盘",
		description: "执行已沉淀的工作流「客户跟进复盘」:读取客户最近会话,汇总未闭环问题并生成下周跟进待办。可传参数:customerKey/days。",
		category: "工作流",
		parameters: { type: "object", properties: { customerKey: {}, days: {} } },
	},
	{
		name: "workflow_wf_2190",
		label: "工作流:周报自动汇总",
		description: "执行已沉淀的工作流「周报自动汇总」:按周统计成交、跟进与话术命中情况,产出一份可发群的周报。可传参数:weekStart。",
		category: "工作流",
		parameters: { type: "object", properties: { weekStart: {} } },
	},
	{
		name: "workflow_wf_8802",
		label: "工作流:竞品政策比对",
		description: "执行已沉淀的工作流「竞品政策比对」:检索知识库里的竞品资料,和本店价格政策逐条比对,输出差异清单。可传参数:competitor。",
		category: "工作流",
		parameters: { type: "object", properties: { competitor: {} } },
	},
];

/** 抓取好的 MCP 工具快照(由 fixtures/capture-mcp-snapshot.mjs 生成) */
interface McpToolSnapshot {
	name: string;
	description: string;
	inputSchema: unknown;
}

/**
 * 本地工具元数据用哪一版:
 *   en = 仓库当前的 readme.json(2026-10 已统一改成英文)
 *   zh = 改造前的中文快照(fixtures/tool-meta-zh.json),用来做"中英元数据"对照评测
 * MCP 工具的元数据来自外部 server,两版都一样(英文),不受此开关影响。
 */
export interface BuildCorpusOptions {
	meta: "en" | "zh";
}

/** 读改造前的中文描述快照(name → 中文 description) */
function loadChineseMeta(): Map<string, string> {
	const fixture = fileURLToPath(new URL("./fixtures/tool-meta-zh.json", import.meta.url));
	const rows = JSON.parse(readFileSync(fixture, "utf8")) as Array<{ name: string; description: string }>;
	return new Map(rows.map((r) => [r.name, r.description]));
}

export async function buildToolDocs(options: BuildCorpusOptions): Promise<ToolDoc[]> {
	const zhMeta = options.meta === "zh" ? loadChineseMeta() : null;
	const docs: ToolDoc[] = [];
	// webSearchApiKey 传非空:与生产一致(生产配了密钥,web_search 是挂载的)
	const local = await loadExternalAgentTools(externalToolPaths(), { db: null, tenantId: "", webSearchApiKey: "eval" });
	for (const tool of local) {
		docs.push({
			name: tool.name,
			label: tool.label ?? tool.name,
			description: (zhMeta?.get(tool.name) ?? String(tool.description ?? "")),
			// 描述语言:readme.json 声明优先(缺省按描述推断)——决定它进中/英哪一路召回
			descriptionLanguage: zhMeta ? "zh" : ((tool as { descriptionLanguage?: "zh" | "en" }).descriptionLanguage ?? "en"),
			category: String((tool as { category?: string }).category ?? ""),
			parameters: tool.parameters,
			params: paramNames(tool.parameters),
			source: "local",
		});
	}
	const fixture = fileURLToPath(new URL("./fixtures/mcp-tools.json", import.meta.url));
	const snapshot = JSON.parse(readFileSync(fixture, "utf8")) as McpToolSnapshot[];
	for (const tool of snapshot) {
		docs.push({
			name: tool.name,
			label: tool.name,
			description: tool.description,
			descriptionLanguage: "en" as const,
			category: "MCP",
			parameters: tool.inputSchema,
			params: paramNames(tool.inputSchema),
			source: "mcp",
		});
	}
	for (const wf of WORKFLOW_SAMPLES) {
		docs.push({
			name: wf.name,
			label: wf.label,
			description: wf.description,
			descriptionLanguage: "zh" as const,
			category: wf.category,
			parameters: wf.parameters,
			params: paramNames(wf.parameters),
			source: "workflow",
		});
	}
	return docs;
}