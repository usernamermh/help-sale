/**
 * 工具检索离线评测:同一套语料 + 同一套测试集,跑多个方案并给出可比指标。
 *
 *   ① 旧方案(裸子串 + 词边界打分)   baseline-substring.ts
 *   ② 词面通道(BM25)               retrieval.searchLexical
 *   ③ 语义通道(BGE 向量余弦)         retrieval.searchSemantic
 *   ④ 双通道 RRF(单条 query)        retrieval.search
 *   ⑤ 双语召回(当前生产方案)        retrieval.searchBilingual —— {zh,en} 两条 query 按工具描述语言分别召回再融合
 *       其中 en 那一路用测试集里的 queryEn(模拟模型在 query 改写步骤里产出的英文 prompt)
 *
 * 两套语料各跑一遍:
 *   全量      本地目录工具 + MCP + 工作流
 *   生产编目   只有 MCP + 工作流(线上编目里真实躺着的那批长尾工具)
 *
 * 用法: npx tsx opimize/catalog/run-eval.ts [--topk=8] [--floor=0.5] [--verbose] [--out=报告路径] [--corpus=all|catalog]
 * 不传参时 topK / semanticFloor / 双语召回参数都取 help-sale.config.yaml 的真实配置(tools.catalog.*)。
 */
import { writeFileSync } from "node:fs";
import { config } from "../../backend/env.ts";
import { ToolRetriever } from "../../backend/mcp/retrieval.ts";
import { legacySearch } from "./baseline-substring.ts";
import { buildToolDocs, type ToolDoc } from "./corpus.ts";
import { CASES, type EvalCase, type EvalKind } from "./dataset.ts";

const args = new Map(
	process.argv.slice(2).map((raw) => {
		const [k, v] = raw.replace(/^--/, "").split("=");
		return [k, v ?? "true"];
	}),
);
const TOP_K = Number(args.get("topk") ?? config.toolsCatalogTopK);
// 语义下限按语言分别配置(英文同语种余弦更高,阈值更高);--floor 覆盖时两档同取该值,便于看趋势
const FLOOR_ARG = args.get("floor");
const FLOORS_CONFIG = FLOOR_ARG === undefined ? { zh: config.toolsCatalogSemanticFloorZh, en: config.toolsCatalogSemanticFloorEn } : { zh: Number(FLOOR_ARG), en: Number(FLOOR_ARG) };
const VERBOSE = args.has("verbose");
const OUT = args.get("out");
const CORPUS = args.get("corpus") ?? "both";
const KINDS: EvalKind[] = ["local", "mcp", "mixed", "rewrite", "en", "chitchat"];
const FLOORS = [0, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7];
const RECALL_OPTIONS = { perLanguageTopK: config.toolsCatalogPerLanguageTopK };

/** 报告既要打屏也要落盘,统一走这个收集器(避免 PowerShell 重定向把中文写成乱码) */
const lines: string[] = [];
function log(line = ""): void {
	lines.push(line);
	console.log(line);
}

type Row = { evalCase: EvalCase; hits: string[] };

/** 用例的"中文侧 / 英文侧"照:<id> 显式给了 queryZh/queryEn 就用它,否则按 query 的语言直接顶(中文问题缺省中文侧、英文问题缺省英文侧)。
 *  两侧都齐的用例才进双语召回对比 —— 也就是全部用例(每条都被改写成了中英两条)。 */
const hasCJK = (text: string | undefined) => /[\u4e00-\u9fa5]/.test(String(text ?? ""));
const zhSide = (c: EvalCase): string | undefined => c.queryZh ?? (hasCJK(c.query) ? c.query : undefined);
const enSide = (c: EvalCase): string | undefined => c.queryEn ?? (hasCJK(c.query) ? undefined : c.query);
type CaseRunner = (evalCase: EvalCase, topK: number) => Promise<string[]>;

/** 只保留"该语料里确实存在被期望工具"的用例(期望集合为空 = 闲聊用例,任何语料都保留) */
function applicableCases(docs: ToolDoc[]): EvalCase[] {
	const names = new Set(docs.map((d) => d.name));
	return CASES.filter((c) => c.expect.length === 0 || c.expect.some((name) => names.has(name)));
}

async function collect(cases: EvalCase[], run: CaseRunner, topK: number): Promise<Row[]> {
	const rows: Row[] = [];
	for (const evalCase of cases) rows.push({ evalCase, hits: await run(evalCase, topK) });
	return rows;
}

function metricsOf(rows: Row[]) {
	const scored = rows.filter((r) => r.evalCase.expect.length > 0);
	const rate = (predicate: (r: Row) => boolean) => (scored.length ? scored.filter(predicate).length / scored.length : Number.NaN);
	const hit1 = rate((r) => r.evalCase.expect.includes(r.hits[0] ?? ""));
	const hit3 = rate((r) => r.hits.slice(0, 3).some((h) => r.evalCase.expect.includes(h)));
	const hit8 = rate((r) => r.hits.slice(0, 8).some((h) => r.evalCase.expect.includes(h)));
	const mrr = scored.length
		? scored.reduce((sum, r) => {
				const rank = r.hits.findIndex((h) => r.evalCase.expect.includes(h));
				return sum + (rank >= 0 ? 1 / (rank + 1) : 0);
			}, 0) / scored.length
		: Number.NaN;
	const precision3 = rows.length ? rows.reduce((sum, r) => sum + r.hits.slice(0, 3).filter((h) => r.evalCase.expect.includes(h)).length / 3, 0) / rows.length : Number.NaN;
	const chat = rows.filter((r) => r.evalCase.kind === "chitchat");
	const chatClean = chat.length ? chat.filter((r) => r.hits.length === 0).length / chat.length : Number.NaN;
	const chatAvg = chat.length ? chat.reduce((sum, r) => sum + r.hits.length, 0) / chat.length : Number.NaN;
	const byKind = Object.fromEntries(
		KINDS.map((kind) => {
			const subset = rows.filter((r) => r.evalCase.kind === kind && r.evalCase.expect.length > 0);
			const ok = subset.filter((r) => r.hits.slice(0, 3).some((h) => r.evalCase.expect.includes(h))).length;
			return [kind, subset.length ? ok / subset.length : Number.NaN];
		}),
	) as Record<EvalKind, number>;
	return { rows, hit1, hit3, hit8, mrr, precision3, chatClean, chatAvg, byKind };
}

type Metrics = ReturnType<typeof metricsOf>;

function pct(x: number): string {
	return Number.isNaN(x) ? "  -   " : `${(x * 100).toFixed(1)}%`;
}

/** 等宽对齐:中文字符按 2 个宽度算(控制台里才不会歪) */
function pad(text: string, width: number): string {
	const widthOf = [...text].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
	return text + " ".repeat(Math.max(0, width - widthOf));
}

/** 按类别拆指标:每个类别的用例数、各档命中数/命中率、MRR、P@3(闲聊另算"返回空") */
function kindBreakdown(title: string, rows: Row[]): string[] {
	const out: string[] = ["", title, "| 类别 | 用例数 | 期望非空 | Top1 命中 | Top3 命中 | Top8 命中 | Top1 | Top3 | Top8 | MRR | P@3 |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"];
	const emit = (label: string, subset: Row[]) => {
		const scored = subset.filter((r) => r.evalCase.expect.length > 0);
		const hit = (n: number) => scored.filter((r) => r.hits.slice(0, n).some((h) => r.evalCase.expect.includes(h))).length;
		const m = metricsOf(subset);
		const counts = scored.length === 0 ? "-" : `${hit(1)}/${scored.length}`;
		const counts3 = scored.length === 0 ? "-" : `${hit(3)}/${scored.length}`;
		const counts8 = scored.length === 0 ? "-" : `${hit(8)}/${scored.length}`;
		out.push(`| ${label} | ${subset.length} | ${scored.length} | ${counts} | ${counts3} | ${counts8} | ${pct(m.hit1)} | ${pct(m.hit3)} | ${pct(m.hit8)} | ${Number.isNaN(m.mrr) ? "-" : m.mrr.toFixed(3)} | ${pct(m.precision3)} |`);
	};
	for (const kind of KINDS) emit(kind, rows.filter((r) => r.evalCase.kind === kind));
	emit("**合计**", rows);
	return out;
}

/** 闲聊专项:该返回空时是否真的返回空 */
function chitchatTable(label: string, rows: Row[]): string[] {
	const chat = rows.filter((r) => r.evalCase.kind === "chitchat");
	const empty = chat.filter((r) => r.hits.length === 0).length;
	const avg = chat.length ? chat.reduce((sum, r) => sum + r.hits.length, 0) / chat.length : 0;
	return [`| ${label} | ${chat.length} | ${empty} | ${pct(chat.length ? empty / chat.length : Number.NaN)} | ${avg.toFixed(2)} |`];
}

function overviewTable(label: string, rows: Array<{ label: string; metrics: Metrics }>): void {
	log(label);
	log(pad("方案", 28) + pad("Top1命中", 10) + pad("Top3命中", 10) + pad("Top8命中", 10) + pad("MRR", 8) + pad("P@3", 8) + pad("闲聊返回空", 12) + pad("闲聊均返回", 12));
	for (const row of rows) {
		log(pad(row.label, 28) + pad(pct(row.metrics.hit1), 10) + pad(pct(row.metrics.hit3), 10) + pad(pct(row.metrics.hit8), 10) + pad(row.metrics.mrr.toFixed(3), 8) + pad(pct(row.metrics.precision3), 8) + pad(pct(row.metrics.chatClean), 12) + pad(row.metrics.chatAvg.toFixed(2), 12));
	}
}

async function report(corpusLabel: string, docs: ToolDoc[]): Promise<void> {
	const cases = applicableCases(docs);
	log("");
	log(`############ 语料:${corpusLabel}(${docs.length} 个工具) ############`);
	log(`本语料适用用例: ${cases.length} 条(期望 ${cases.filter((c) => c.expect.length > 0).length} + 闲聊 ${cases.filter((c) => c.kind === "chitchat").length})`);
	log(`参数: topK=${TOP_K} floorZh=${FLOORS_CONFIG.zh} floorEn=${FLOORS_CONFIG.en} perLanguageTopK=${RECALL_OPTIONS.perLanguageTopK}(均来自配置 tools.catalog.*)`);
	const retriever = new ToolRetriever(docs, { semanticFloors: FLOORS_CONFIG });
	const started = Date.now();
	await retriever.searchSemantic("预热:构建文档向量索引", 1);
	const langs = retriever.countByLanguage();
	log(`文档向量索引构建耗时: ${Date.now() - started}ms;候选池语言分布: zh ${langs.zh} 个 / en ${langs.en} 个`);

	// 双语召回:两段分开返回 —— 期望工具在哪一段,就看它在"自己那一段"的排名(闲聊看两段是否都为空)
	const expectedLang = new Map(docs.map((d) => [d.name, d.descriptionLanguage ?? "en"]));
	const sectionHits = async (c: EvalCase): Promise<string[]> => {
		const grouped = await retriever.searchGrouped({ zh: zhSide(c) ?? "", en: enSide(c) ?? "" }, RECALL_OPTIONS);
		if (c.expect.length === 0) return [...grouped.zh, ...grouped.en];
		const lang = expectedLang.get(c.expect.find((name) => expectedLang.has(name)) ?? c.expect[0]) ?? "en";
		return lang === "zh" ? grouped.zh : grouped.en;
	};
	const methods: Array<{ label: string; run: CaseRunner }> = [
		{ label: "① 旧方案 裸子串+词边界", run: async (c, k) => legacySearch(docs, c.query, k) },
		{ label: "② 词面 BM25", run: async (c, k) => retriever.searchLexical(c.query, k) },
		{ label: "③ 语义 BGE 向量", run: async (c, k) => retriever.searchSemantic(c.query, k) },
		{ label: "④ 双通道(单条 query)", run: async (c, k) => retriever.search(c.query, k) },
	];
	const results: Array<{ label: string; metrics: Metrics }> = [];
	for (const method of methods) results.push({ label: method.label, metrics: metricsOf(await collect(cases, method.run, TOP_K)) });

	log("");
	overviewTable(`== 总览 1:单条 query 的四种方案(${cases.length} 条查询) ==`, results);

	log("");
	log("== 分类型 Top3 命中率(单条 query) ==");
	log(pad("方案", 28) + pad("local", 9) + pad("mcp", 9) + pad("mixed", 9) + pad("rewrite", 10) + pad("en", 9));
	for (const row of results) {
		log(pad(row.label, 28) + pad(pct(row.metrics.byKind.local), 9) + pad(pct(row.metrics.byKind.mcp), 9) + pad(pct(row.metrics.byKind.mixed), 9) + pad(pct(row.metrics.byKind.rewrite), 10) + pad(pct(row.metrics.byKind.en), 9));
	}

	// 双语召回:只在"同时有中文问题 + 英文改写"的成对用例上比,保证两个方案面对完全相同的用例
	const paired = cases.filter((c) => (zhSide(c) ?? "").trim().length > 0 && (enSide(c) ?? "").trim().length > 0);
	if (paired.length > 0) {
		const single = metricsOf(await collect(paired, async (c, k) => retriever.search(c.query, k), TOP_K));

		const bilingual = metricsOf(await collect(paired, async (c) => sectionHits(c), TOP_K));
		log("");
		overviewTable(`== 总览 2:双语召回 vs 单条 query(中英两侧 query 齐全的 ${paired.length} 条用例) ==`, [
			{ label: "④ 单条 query(改造前)", metrics: single },
			{ label: "⑤ 双语召回(当前生产)", metrics: bilingual },
		]);
		log("");
		log("== 分类型 Top3 命中率(同一批用例) ==");
		log(pad("方案", 28) + pad("local", 9) + pad("mcp", 9) + pad("mixed", 9) + pad("rewrite", 10) + pad("en", 9));
		for (const row of [{ label: "④ 单条 query(改造前)", metrics: single }, { label: "⑤ 双语召回(当前生产)", metrics: bilingual }]) {
			log(pad(row.label, 28) + pad(pct(row.metrics.byKind.local), 9) + pad(pct(row.metrics.byKind.mcp), 9) + pad(pct(row.metrics.byKind.mixed), 9) + pad(pct(row.metrics.byKind.rewrite), 10) + pad(pct(row.metrics.byKind.en), 9));
		}
		log("");
		log(`== 双语召回 未命中 / 误召回明细(floorZh=${FLOORS_CONFIG.zh} floorEn=${FLOORS_CONFIG.en}) ==`);
		for (const { evalCase, hits } of bilingual.rows) {
			const ok = evalCase.expect.length === 0 ? hits.length === 0 : hits.slice(0, 3).some((h) => evalCase.expect.includes(h));
			if (ok) continue;
			log(`✗ ${evalCase.id} [${evalCase.kind}] ${evalCase.query}`);
			log(`   zh: ${zhSide(evalCase)} / en: ${enSide(evalCase)}`);
			log(`   期望: ${evalCase.expect.join(", ") || "(不应命中任何工具)"}`);
			log(`   实际: ${hits.slice(0, 5).join(", ") || "(空)"}`);
		}
	} else {
		log("");
		log("(本语料没有中英两侧 query 齐全的用例,跳过双语召回对比)");
	}

	// 按类别明细:两种方案都跑一遍全量适用用例,逐类给出用例数与各档指标
	const singleRows = await collect(cases, async (c, k) => retriever.search(c.query, k), TOP_K);
	const bilingualRows = await collect(cases, async (c) => sectionHits(c), TOP_K);
	for (const line of kindBreakdown("== 按类别指标 1:单条 query(改造前) ==", singleRows)) log(line);
	for (const line of kindBreakdown("== 按类别指标 2:双语召回(当前生产) ==", bilingualRows)) log(line);
	log("");
	log("== 闲聊专项:期望为「不应命中任何工具」的用例 ==");
	log("| 方案 | 用例数 | 返回空 | 返回空率 | 平均返回条数 |");
	log("| --- | --- | --- | --- | --- |");
	for (const line of chitchatTable("单条 query(改造前)", singleRows)) log(line);
	for (const line of chitchatTable("双语召回(当前生产)", bilingualRows)) log(line);

	log("");
	log("== semanticFloor 敏感性(单条 query 的双通道方案;两档下限同取该值) ==");
	log(pad("floor", 9) + pad("Top1命中", 10) + pad("Top3命中", 10) + pad("Top8命中", 10) + pad("P@3", 8) + pad("闲聊返回空", 12));
	for (const floor of FLOORS) {
		const sweeper = new ToolRetriever(docs, { semanticFloors: { zh: floor, en: floor } });
		const metrics = metricsOf(await collect(cases, async (c, k) => sweeper.search(c.query, k), TOP_K));
		log(pad(String(floor), 9) + pad(pct(metrics.hit1), 10) + pad(pct(metrics.hit3), 10) + pad(pct(metrics.hit8), 10) + pad(pct(metrics.precision3), 8) + pad(pct(metrics.chatClean), 12));
	}

	if (VERBOSE) {
		log("");
		log("== 逐条明细(单条 query 的双通道) ==");
		for (const { evalCase, hits } of results[3].metrics.rows) log(`   ${evalCase.id} [${evalCase.kind}] ${evalCase.query} → ${hits.join(", ") || "(空)"}`);
	}
}

async function main(): Promise<void> {
	const all = await buildToolDocs();
	const catalogOnly = all.filter((d) => d.source !== "local");
	log(`语料明细: 本地目录 ${all.filter((d) => d.source === "local").length} / MCP ${all.filter((d) => d.source === "mcp").length} / 工作流 ${all.filter((d) => d.source === "workflow").length}`);
	log(`测试集: ${CASES.length} 条查询,每条都已配中英两侧 query(zh/en),全部进入双语召回对比`);
	if (CORPUS !== "catalog") await report("全量:本地目录 + MCP + 工作流", all);
	if (CORPUS !== "all") await report("生产编目:仅 MCP + 工作流", catalogOnly);
	if (OUT) {
		writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
		console.log(`\n报告已写入 ${OUT}`);
	}
}

await main();
// embedding worker 是常驻线程,不主动退出进程会一直挂着(评测脚本跑完即结束)
process.exit(0);