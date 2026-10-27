/**
 * 干净基准评测:100 个英文 MCP + 100 个中文工作流,只测"双语召回"这一套生产方案。
 *
 * 语料两边完全对称(各 100 个),每条用例的正确答案固定落在其中一个语言的池子里:
 *   - MCP 组的正确答案在英文池(中文 query 走不到,靠 en 那一路召回);
 *   - 工作流组的正确答案在中文池(英文 query 走不到,靠 zh 那一路召回)。
 * 两段分开返回,所以排名只看"它在自己那一段里的位置",另一段是另一个语言族的候选,不参与这个排名。
 *
 * 用法: npx tsx opimize/catalog/run-eval-large.ts [--topk=8] [--out=large-run.txt]
 * 参数(每语言下限 / 每段条数)全部来自 help-sale.config.yaml 的 tools.catalog.*
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "../../backend/env.ts";
import { ToolRetriever } from "../../backend/mcp/retrieval.ts";

interface McpToolFixture {
	name: string;
	description: string;
	inputSchema: unknown;
}
interface WorkflowFixture {
	name: string;
	label: string;
	description: string;
	steps: Array<{ name: string; tool: string; params: unknown }>;
}
interface CaseFixture {
	id: string;
	group: "mcp" | "workflow";
	zh: string;
	en: string;
	expect: string;
}

const args = new Map(
	process.argv.slice(2).map((raw) => {
		const [k, v] = raw.replace(/^--/, "").split("=");
		return [k, v ?? "true"];
	}),
);
const TOP_K = Number(args.get("topk") ?? config.toolsCatalogTopK);
const OUT = args.get("out") ?? "large-run.txt";
const RECALL = { perLanguageTopK: config.toolsCatalogPerLanguageTopK };
const FLOORS = { zh: config.toolsCatalogSemanticFloorZh, en: config.toolsCatalogSemanticFloorEn };

const read = <T,>(file: string): T => JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/" + file, import.meta.url)), "utf8")) as T;
const mcpTools = read<McpToolFixture[]>("mcp-en-100.json");
const workflows = read<WorkflowFixture[]>("workflow-zh-100.json");
const cases = read<CaseFixture[]>("cases-200.json");

const lines: string[] = [];
function log(line = ""): void {
	lines.push(line);
	console.log(line);
}

const docs = [
	...workflows.map((w) => ({ name: w.name, label: w.label, description: w.description, descriptionLanguage: "zh" as const, parameters: { type: "object" } })),
	...mcpTools.map((t) => ({ name: t.name, description: t.description, descriptionLanguage: "en" as const, parameters: t.inputSchema })),
];

function pct(n: number, d: number): string {
	return d ? ((n / d) * 100).toFixed(1) + "%" : "-";
}

interface Result {
	group: "mcp" | "workflow";
	section: string[];
	other: string[];
	rank: number;
}

async function main(): Promise<void> {
	const retriever = new ToolRetriever(docs, { semanticFloors: FLOORS });
	const started = Date.now();
	await retriever.searchSemantic("预热", 1);
	const buildMs = Date.now() - started;
	const pools = retriever.countByLanguage();

	log("# 干净基准:100 英文 MCP + 100 中文工作流(只测双语召回)");
	log("");
	log("语料: " + docs.length + " 个工具(中文池 zh " + pools.zh + " / 英文池 en " + pools.en + ");向量索引构建 " + buildMs + "ms");
	log("用例: " + cases.length + " 条(MCP 组 " + cases.filter((c) => c.group === "mcp").length + " + 工作流组 " + cases.filter((c) => c.group === "workflow").length + "),每条都已配 zh/en 两侧 query");
	log("参数: topK=" + TOP_K + " floorZh=" + FLOORS.zh + " floorEn=" + FLOORS.en + " perLanguageTopK=" + RECALL.perLanguageTopK + "(均来自配置)");

	const results: Result[] = [];
	for (const c of cases) {
		const grouped = await retriever.searchGrouped({ zh: c.zh, en: c.en }, RECALL);
		const section = c.group === "mcp" ? grouped.en : grouped.zh;
		const other = c.group === "mcp" ? grouped.zh : grouped.en;
		results.push({ group: c.group, section, other, rank: section.indexOf(c.expect) });
	}

	log("");
	log("## 1. 双语召回命中率(排名只算自己那一段)");
	log("| 组 | 用例数 | 该段平均条数 | Top1 | Top3 | Top8 | MRR | 另一段平均条数 |");
	log("| --- | --- | --- | --- | --- | --- | --- | --- |");
	const emit = (label: string, subset: Result[]) => {
		const n = subset.length;
		const within = (k: number) => subset.filter((r) => r.rank >= 0 && r.rank < k).length;
		const mrr = subset.reduce((s, r) => s + (r.rank >= 0 ? 1 / (r.rank + 1) : 0), 0) / Math.max(1, n);
		const avgSection = subset.reduce((s, r) => s + r.section.length, 0) / Math.max(1, n);
		const avgOther = subset.reduce((s, r) => s + r.other.length, 0) / Math.max(1, n);
		log("| " + label + " | " + n + " | " + avgSection.toFixed(1) + " | " + pct(within(1), n) + " | " + pct(within(3), n) + " | " + pct(within(8), n) + " | " + mrr.toFixed(3) + " | " + avgOther.toFixed(2) + " |");
	};
	emit("MCP(英文池)", results.filter((r) => r.group === "mcp"));
	emit("工作流(中文池)", results.filter((r) => r.group === "workflow"));
	emit("**合计**", results);

	log("");
	log("## 2. 正确答案落在自己那一段的第几名");
	log("| 组 | 第 1 名 | 第 2-3 名 | 第 4-8 名 | 没进该段 |");
	log("| --- | --- | --- | --- | --- |");
	for (const group of ["mcp", "workflow"] as const) {
		const subset = results.filter((r) => r.group === group);
		const first = subset.filter((r) => r.rank === 0).length;
		const second = subset.filter((r) => r.rank === 1 || r.rank === 2).length;
		const rest = subset.filter((r) => r.rank >= 3).length;
		const none = subset.filter((r) => r.rank < 0).length;
		log("| " + (group === "mcp" ? "MCP(英文池)" : "工作流(中文池)") + " | " + first + "/" + subset.length + " | " + second + "/" + subset.length + " | " + rest + "/" + subset.length + " | " + none + "/" + subset.length + " |");
	}

	log("");
	log("## 3. 未进前三名的用例明细(最多 10 条)");
	const misses = results.filter((r) => r.rank < 0 || r.rank >= 3).slice(0, 10);
	if (misses.length === 0) log("(没有任何用例掉出前 3)");
	for (const r of misses) {
		const c = cases[results.indexOf(r)];
		log("- " + c.id + " [" + c.group + "] zh=" + c.zh + " / en=" + c.en + " → 期望 " + c.expect + ";实际该段前 3 名=" + (r.section.slice(0, 3).join(", ") || "(空)") + "(正确项在第 " + (r.rank + 1) + " 名)");
	}

	if (OUT) {
		writeFileSync(fileURLToPath(new URL("./" + OUT, import.meta.url)), lines.join("\n") + "\n", "utf8");
		console.log("\n报告已写入 " + OUT);
	}
}

await main();
process.exit(0);