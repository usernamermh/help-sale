/**
 * 召回率评测:100 条中文 query(30 条只依赖中文工具、30 条只依赖英文工具、40 条中英都要),
 * 每条 query 预先标注"至少 3 个期望工具";英文翻译只用来走 en 那一路(模拟改写产物),分母固定 100。
 *
 * 指标:recall@N = 期望工具集合里,出现在"前 N 条候选"中的比例,再对 100 条取平均。
 *   「前 N 条候选」= 中文段前 N ∪ 英文段前 N(两段分开返回,没有跨语言统一排序;
 *     期望工具只会出现在它自己语言那一段,所以另一段不影响这个比例)。
 *
 * 用法: npx tsx opimize/catalog/run-eval-recall.ts [--out=recall-run.txt]
 * 参数(各语言语义下限 / 每段条数)全部来自 help-sale.config.yaml 的 tools.catalog.*
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "../../backend/env.ts";
import { ToolRetriever } from "../../backend/mcp/retrieval.ts";

interface ZhTool {
	name: string;
	label: string;
	description: string;
}
interface EnTool {
	name: string;
	description: string;
}
interface RecallQuery {
	id: string;
	group: "zh" | "en" | "mix";
	expect: string[];
	zh: string;
	en: string;
}

const args = new Map(
	process.argv.slice(2).map((raw) => {
		const [k, v] = raw.replace(/^--/, "").split("=");
		return [k, v ?? "true"];
	}),
);
const OUT = args.get("out") ?? "recall-run.txt";
const CUTOFFS = [1, 3, 5, 8];
const PER_LANGUAGE = config.toolsCatalogPerLanguageTopK;
const FLOORS = { zh: config.toolsCatalogSemanticFloorZh, en: config.toolsCatalogSemanticFloorEn };
const GROUPS: Array<RecallQuery["group"]> = ["zh", "en", "mix"];

const read = <T,>(file: string): T => JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/" + file, import.meta.url)), "utf8")) as T;
const zhTools = read<ZhTool[]>("recall-tools-zh.json");
const enTools = read<EnTool[]>("recall-tools-en.json");
const queries = read<RecallQuery[]>("recall-queries-100.json");

const docs = [
	...zhTools.map((t) => ({ name: t.name, label: t.label, description: t.description, descriptionLanguage: "zh" as const, parameters: { type: "object" } })),
	...enTools.map((t) => ({ name: t.name, description: t.description, descriptionLanguage: "en" as const, parameters: { type: "object" } })),
];

const lines: string[] = [];
function log(line = ""): void {
	lines.push(line);
	console.log(line);
}

function pct(x: number): string {
	return (x * 100).toFixed(1) + "%";
}

async function main(): Promise<void> {
	const retriever = new ToolRetriever(docs, { semanticFloors: FLOORS });
	const started = Date.now();
	await retriever.searchSemantic("预热", 1);
	const pools = retriever.countByLanguage();
	log("# 召回率评测:100 条中文 query(每条至少 3 个期望工具)");
	log("");
	log("语料: " + docs.length + " 个工具(中文池 " + pools.zh + " 个 / 英文池 " + pools.en + " 个);索引构建 " + (Date.now() - started) + "ms");
	log("参数: 每段返回 " + PER_LANGUAGE + " 条,语义下限 zh " + FLOORS.zh + " / en " + FLOORS.en + "(来自配置)");
	log("分值口径:recall@N = 期望工具落在「中文段前 N ∪ 英文段前 N」的比例,再对同组 query 取平均;分母固定 100 条 query");
	log("");

	const rows: Array<{ q: RecallQuery; recalls: Record<number, number>; hitNames: Record<number, string[]> }> = [];
	for (const q of queries) {
		const grouped = await retriever.searchGrouped({ zh: q.zh, en: q.en }, { perLanguageTopK: PER_LANGUAGE });
		const recalls: Record<number, number> = {};
		const hitNames: Record<number, string[]> = {};
		for (const n of CUTOFFS) {
			const pool = new Set([...grouped.zh.slice(0, n), ...grouped.en.slice(0, n)]);
			const hit = q.expect.filter((name) => pool.has(name));
			recalls[n] = hit.length / q.expect.length;
			hitNames[n] = hit;
		}
		rows.push({ q, recalls, hitNames });
	}

	const meanRecall = (subset: typeof rows, n: number) => (subset.length ? subset.reduce((s, r) => s + r.recalls[n], 0) / subset.length : Number.NaN);

	log("| 组 | query 数 | 期望工具数 | recall@1 | recall@3 | recall@5 | recall@8 |");
	log("| --- | --- | --- | --- | --- | --- | --- |");
	const label = (group: RecallQuery["group"]) => (group === "zh" ? "纯中文工具" : group === "en" ? "纯英文工具" : "中英混合");
	for (const group of GROUPS) {
		const subset = rows.filter((r) => r.q.group === group);
		const expectTotal = subset.reduce((s, r) => s + r.q.expect.length, 0);
		log("| " + label(group) + " | " + subset.length + " | " + expectTotal + " | " + CUTOFFS.map((n) => pct(meanRecall(subset, n))).join(" | ") + " |");
	}
	const expectTotal = rows.reduce((s, r) => s + r.q.expect.length, 0);
	log("| **合计** | " + rows.length + " | " + expectTotal + " | " + CUTOFFS.map((n) => pct(meanRecall(rows, n))).join(" | ") + " |");

	const worst = [...rows].sort((a, b) => a.recalls[8] - b.recalls[8]).slice(0, 5);
	log("");
	log("recall@8 最低的 5 条:");
	for (const r of worst) {
		const miss = r.q.expect.filter((name) => !r.hitNames[8].includes(name));
		log("- " + r.q.id + "[" + r.q.group + "] recall@8=" + r.recalls[8].toFixed(2) + " 漏掉:" + miss.join(", ") + " ← " + r.q.zh);
	}

	if (OUT) {
		writeFileSync(fileURLToPath(new URL("./" + OUT, import.meta.url)), lines.join("\n") + "\n", "utf8");
		console.log("\n报告已写入 " + OUT);
	}
}

await main();
process.exit(0);