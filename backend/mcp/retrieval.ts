/**
 * 工具检索:词面 + 语义双通道,RRF 融合(不含 LLM rerank),并支持"按描述语言分别召回"。
 *
 *   词面通道(BM25):解决"名字 / 参数名 / 术语精确命中";
 *   语义通道(BGE 向量余弦):解决"自然语言改写";
 *   融合(RRF):只看两路的排名,不用分数,规避量纲不可比。
 *
 * 语言:每个文档带 description_language(zh/en)。工具描述中英混杂时,如果放在同一个池子里比分数,
 * 命中会按"语言"分派而不是按"相关度"分派(中文 query 天然只命中中文文档)。
 * 所以生产入口是 searchBilingual():把同一句需求改写成 {"zh","en"} 两条 query,
 * zh query 只召回中文描述的工具、en query 只召回英文描述的工具,两路结果再 RRF 融合。
 */
import { embedTextsSafe } from "../../tools_system/_shared/bge-embed.js";
import { cosineSim } from "../../tools_system/_shared/text-vec.js";

/** 工具描述语言 */
export type DescriptionLanguage = "zh" | "en";

/** 双语改写后的两条 query(由模型产出,见 backend/mcp/query-rewrite.ts) */
export interface BilingualQuery {
	zh: string;
	en: string;
}

/** 参与检索的文档(工具编目条目或其等价物) */
export interface RetrievalDoc {
	name: string;
	label?: string;
	description: string;
	category?: string;
	/** 该工具描述的语言:决定它进哪一路召回 */
	descriptionLanguage?: DescriptionLanguage;
	/** 参数 JSON Schema:只取属性名进索引文本(参数名往往比描述更能说明工具用途) */
	parameters?: unknown;
}

/** 文本向量化入口:默认走本地 BGE(模型缺失时 embedTextsSafe 自动回退字符 n-gram) */
export type Embedder = (texts: string[]) => Promise<number[][]>;

export interface ToolRetrieverOptions {
	/**
	 * 语义通道相似度下限(按描述语言分别配置):低于该值的候选不进语义通道,用于挡住与工具无关的闲聊。
	 * 必须分开配的原因:BGE 对同语种文本的余弦天然更高(实测英文闲聊 0.44~0.55,英文正例 0.65~0.75;
	 * 中文闲聊 ≤0.44),用同一个阈值会出现"中文挡得住、英文挡不住"。
	 */
	semanticFloors: { zh: number; en: number };
	/** 向量化实现(测试注入用;默认本地 BGE) */
	embed?: Embedder;
}

const STOPWORDS = new Set([
	"a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "does", "for", "from", "how", "i", "in", "is", "it",
	"me", "my", "of", "on", "or", "please", "the", "this", "that", "to", "use", "was", "what", "when", "where", "which",
	"who", "why", "with", "you", "your",
]);
const CJK_STOPWORDS = new Set(["的", "了", "和", "与", "是", "在", "把", "给", "请", "帮我", "一下", "怎么", "如何", "什么", "这个", "那个", "他", "她", "它"]);

/** 英文/数字词最小长度:比这短的一律丢(is/a/to 这类词没有区分度) */
const MIN_ASCII_TOKEN = 3;
const ASCII = /[a-z0-9]/;
const CJK = /[\u4e00-\u9fa5]/;

/**
 * 驼峰/字母数字边界拆词:createPullRequest → create Pull Request。
 * 工具名里的驼峰若整块留下(upsertRecord),整词查询 "upsert" 就永远匹配不上。
 */
export function splitCamel(text: string): string {
	return String(text ?? "")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Za-z])([0-9])/g, "$1 $2")
		.replace(/([0-9])([A-Za-z])/g, "$1 $2");
}

/**
 * 轻量英文词形归一:复数/第三人称 -s 还原(branches → branch,issues → issue)。
 * 只做这一步:再重的词干化(去 ing/ed、词根)容易误伤工具名里的专有词。
 */
function stemAscii(token: string): string {
	if (token.length <= 3) return token;
	if (token.endsWith("ies")) return `${token.slice(0, -3)}y`;
	if (/(ches|shes|xes|zes)$/.test(token)) return token.slice(0, -2);
	if (token.endsWith("sses")) return token.slice(0, -2);
	if (token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
	return token;
}

/**
 * 查询/文档通用分词:驼峰拆词 → 非字母数字切 → 中英脚本边界切(`创建issue` 也能切出 `issue`);
 * 英文整词保留(≥3 且非停用词,做单复数归一),中文切二元组。
 */
export function tokenize(text: string): string[] {
	const runs = splitCamel(String(text ?? "")).toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fa5]+/g) ?? [];
	const tokens = new Set<string>();
	for (const run of runs) {
		if (ASCII.test(run[0] ?? "")) {
			if (run.length >= MIN_ASCII_TOKEN && !STOPWORDS.has(run)) {
				const stem = stemAscii(run);
				if (!STOPWORDS.has(stem)) tokens.add(stem);
			}
			continue;
		}
		if (!CJK.test(run[0] ?? "")) continue;
		if (run.length === 1) {
			if (!CJK_STOPWORDS.has(run)) tokens.add(run);
			continue;
		}
		for (let i = 0; i + 2 <= run.length; i++) {
			const bigram = run.slice(i, i + 2);
			if (!CJK_STOPWORDS.has(bigram)) tokens.add(bigram);
		}
	}
	return [...tokens];
}

/** 描述语言推断:含中文即视为 zh,否则 en(工具可在 readme.json 里显式声明,以声明为准) */
export function detectDescriptionLanguage(text: string): DescriptionLanguage {
	return CJK.test(String(text ?? "")) ? "zh" : "en";
}

/** 参数 schema 的属性名(参数名进了索引文本,工具用途从参数名上往往比描述更清楚) */
export function paramNames(schema: unknown): string[] {
	const props = (schema as { properties?: Record<string, unknown> } | null)?.properties;
	return props && typeof props === "object" ? Object.keys(props) : [];
}

/** 名称/标签拆词(下划线、连字符、驼峰边界都视为分隔符) */
function nameWordsOf(doc: RetrievalDoc): string {
	return splitCamel([doc.name, doc.label ?? ""].join(" "))
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fa5]+/g, " ")
		.trim();
}

/** 文档索引文本:名称词 + 原始名 + 展示名 + 描述 + 参数名 + 分类 */
export function indexTextOf(doc: RetrievalDoc): string {
	return [nameWordsOf(doc), doc.name, doc.label ?? "", doc.description, paramNames(doc.parameters).join(" "), doc.category ?? ""].filter(Boolean).join(" \n ");
}

/** RRF 融合:只吃各路排名,score = Σ 1/(k + rank) */
export function rrf(lists: string[][], limit: number, k = 60): string[] {
	const score = new Map<string, number>();
	for (const list of lists) {
		list.forEach((name, i) => score.set(name, (score.get(name) ?? 0) + 1 / (k + i + 1)));
	}
	return [...score.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, Math.max(1, limit))
		.map(([name]) => name);
}

export interface BilingualRecallOptions {
	/** 每种语言各自召回多少条(两段各自截断) */
	perLanguageTopK: number;
}

/** 双语召回结果:两段分开返回,不做跨语言混排 */
export interface GroupedRecall {
	/** 中文描述的工具(由 zh query 召回) */
	zh: string[];
	/** 英文描述的工具(由 en query 召回) */
	en: string[];
}

/** 向量缓存:工具文档在多次运行之间是稳定的,缓存住避免每轮重复推理 */
const VECTOR_CACHE_MAX = 4096;
const vectorCache = new Map<string, number[]>();

async function embedCached(embed: Embedder, texts: string[]): Promise<number[][]> {
	const out: number[][] = texts.map(() => []);
	const missing: number[] = [];
	for (let i = 0; i < texts.length; i++) {
		const key = String(texts[i] ?? "");
		if (!key.trim()) continue;
		const cached = vectorCache.get(key);
		if (cached) out[i] = cached;
		else missing.push(i);
	}
	if (missing.length > 0) {
		const vecs = await embed(missing.map((i) => String(texts[i])));
		missing.forEach((index, order) => {
			const vec = vecs[order];
			if (!vec || vec.length === 0) return;
			out[index] = vec;
			if (vectorCache.size >= VECTOR_CACHE_MAX) vectorCache.clear();
			vectorCache.set(String(texts[index]), vec);
		});
	}
	return out;
}

/**
 * 双通道检索器:
 *   searchLexical  词面(BM25,名称词权重 3、参数名权重 2)
 *   searchSemantic 语义(余弦,低于 semanticFloor 的不进榜)
 *   search         单条 query 的两路融合(可限定描述语言)
 *   searchBilingual 生产入口:{zh,en} 两条 query 按语言分别召回,再融合
 */
export class ToolRetriever {
	private docs: RetrievalDoc[];
	private embed: Embedder;
	private semanticFloors: { zh: number; en: number };
	private tf = new Map<string, Map<string, number>>();
	private df = new Map<string, number>();
	private avgLen = 0;
	private vectors: Map<string, number[]> | null = null;
	private building: Promise<void> | null = null;

	constructor(docs: RetrievalDoc[], options: ToolRetrieverOptions) {
		this.docs = docs.map((doc) => ({ ...doc, descriptionLanguage: doc.descriptionLanguage ?? detectDescriptionLanguage(doc.description) }));
		this.embed = options.embed ?? embedTextsSafe;
		this.semanticFloors = options.semanticFloors;
		let total = 0;
		for (const doc of this.docs) {
			const tokens = [
				...tokenize(nameWordsOf(doc)).flatMap((t) => [t, t, t]), // 名称词 ×3
				...paramNames(doc.parameters).flatMap((p) => tokenize(p)).flatMap((t) => [t, t]), // 参数名 ×2
				...tokenize(indexTextOf(doc)),
			];
			const counts = new Map<string, number>();
			for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
			this.tf.set(doc.name, counts);
			total += tokens.length;
			for (const token of counts.keys()) this.df.set(token, (this.df.get(token) ?? 0) + 1);
		}
		this.avgLen = this.docs.length > 0 ? total / this.docs.length : 0;
	}

	/** 某个候选池的语义下限(语言缺省时按中文那一档,偏保守) */
	private floorFor(language?: DescriptionLanguage): number {
		return language === "en" ? this.semanticFloors.en : this.semanticFloors.zh;
	}

	/** 按描述语言取候选池(不传语言 = 全部) */
	private pool(language?: DescriptionLanguage): RetrievalDoc[] {
		if (!language) return this.docs;
		return this.docs.filter((d) => d.descriptionLanguage === language);
	}

	/** 各语言各有多少工具(调试/评测用) */
	countByLanguage(): Record<DescriptionLanguage, number> {
		return {
			zh: this.pool("zh").length,
			en: this.pool("en").length,
		};
	}

	/** 词面通道:BM25(k1=1.2 / b=0.75 是通用取值,不做部署级调参) */
	searchLexical(query: string, limit: number, language?: DescriptionLanguage): string[] {
		const tokens = tokenize(query);
		if (tokens.length === 0) return [];
		const k1 = 1.2;
		const b = 0.75;
		const pool = this.pool(language);
		const N = pool.length || 1;
		const scored: Array<[string, number]> = [];
		for (const doc of pool) {
			const counts = this.tf.get(doc.name);
			if (!counts) continue;
			const len = [...counts.values()].reduce((s, v) => s + v, 0);
			let score = 0;
			for (const token of tokens) {
				const f = counts.get(token);
				if (!f) continue;
				const n = this.df.get(token) ?? 0;
				const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
				score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * len) / this.avgLen)));
			}
			if (score > 0) scored.push([doc.name, score]);
		}
		return scored
			.sort((a, b2) => b2[1] - a[1] || a[0].localeCompare(b2[0]))
			.slice(0, Math.max(1, limit))
			.map(([name]) => name);
	}

	/** 语义通道:文档向量懒构建(只建一次),查询向量现算 */
	async searchSemantic(query: string, limit: number, language?: DescriptionLanguage): Promise<string[]> {
		if (!String(query ?? "").trim()) return [];
		await this.ensureVectors();
		if (!this.vectors || this.vectors.size === 0) return [];
		const [queryVec] = await embedCached(this.embed, [query]);
		if (!queryVec || queryVec.length === 0) return [];
		const scored: Array<[string, number]> = [];
		for (const doc of this.pool(language)) {
			const vec = this.vectors.get(doc.name);
			if (!vec) continue;
			const sim = cosineSim(queryVec, vec);
			if (sim >= this.floorFor(doc.descriptionLanguage)) scored.push([doc.name, sim]);
		}
		return scored
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.slice(0, Math.max(1, limit))
			.map(([name]) => name);
	}

	/**
	 * 单条 query 的双通道融合:两路各多取一些候选(融合条数的 2 倍)再融合,避免"某路第 5 名"被单路截断误伤;
	 * 可限定只在某一语言的候选池里召回。两路都空时返回空(让模型知道"没有可用工具")。
	 */
	async search(query: string, limit: number, language?: DescriptionLanguage): Promise<string[]> {
		const pool = Math.max(limit * 2, limit + 5);
		const lexical = this.searchLexical(query, pool, language);
		const semantic = await this.searchSemantic(query, pool, language);
		if (lexical.length === 0 && semantic.length === 0) return [];
		return rrf([lexical, semantic], limit);
	}

	/**
	 * 生产入口:双语召回(两段分开返回,**不做跨语言混排**)。
	 *   zh query → 只在中文描述的工具里召回;en query → 只在英文描述的工具里召回;
	 *   模型自己那次 search_tools 的 query 按语言并入对应那一段。
	 *
	 * 为什么不再融合成一条榜单:两段的"第 1 名"在 RRF 里分数完全相同(都是 1/(k+1)),
	 * 谁排前面只能靠工具名/语言去猜 —— 干净基准上实测过:并列时按名字排序会让 mcp_* 压过 workflow_*,
	 * 中文工作流的 Top1 直接掉到 0%。分语言两段返回,跨语言的取舍交给模型按描述自己判断,才是稳定的。
	 */
	async searchGrouped(queries: BilingualQuery, options: BilingualRecallOptions, extraQuery?: string): Promise<GroupedRecall> {
		const per = Math.max(1, options.perLanguageTopK);
		const extra = String(extraQuery ?? "").trim();
		const pick = async (query: string, language: DescriptionLanguage, extraForThisLanguage: string[]): Promise<string[]> => {
			const q = String(query ?? "").trim();
			const lists: string[][] = [];
			if (q && this.pool(language).length > 0) lists.push(await this.search(q, per, language));
			for (const extraQueryText of extraForThisLanguage) {
				if (extraQueryText && this.pool(language).length > 0) lists.push(await this.search(extraQueryText, per, language));
			}
			if (lists.length === 0) return [];
			// 同一段里多路(改写 + 模型自补 query)仍然用 RRF 合并排名,再去重截断
			const merged = lists.length === 1 ? lists[0] : rrf(lists, per);
			return [...new Set(merged)].slice(0, per);
		};
		const extraLanguage = extra ? detectDescriptionLanguage(extra) : undefined;
		const [zh, en] = await Promise.all([
			pick(queries.zh, "zh", extraLanguage === "zh" ? [extra] : []),
			pick(queries.en, "en", extraLanguage === "en" ? [extra] : []),
		]);
		return { zh, en };
	}
	private async ensureVectors(): Promise<void> {
		if (this.vectors) return;
		if (!this.building) {
			this.building = (async () => {
				const vecs = await embedCached(this.embed, this.docs.map((d) => indexTextOf(d)));
				const map = new Map<string, number[]>();
				this.docs.forEach((doc, i) => {
					const vec = vecs[i];
					if (vec && vec.length > 0) map.set(doc.name, vec);
				});
				this.vectors = map;
			})();
		}
		await this.building;
	}
}