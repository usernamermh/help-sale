/**
 * 工具编目(Catalog):把"本轮可见的全部工具"编成可检索目录,支持三层调用——
 *   1) search_tools(query)       → 只返回 工具名 + 一行描述(不含参数 schema)
 *   2) get_tool_details(name)    → 只返回这一个工具的完整 schema
 *   3) call_tool(name, args)     → 校验名字后真正执行
 *
 * 检索在 retrieval.ts:词面(BM25)+ 语义(BGE 向量)双通道 RRF 融合,不含 LLM rerank。
 * 语言:每个条目带 description_language(zh/en)。目录里中英工具混装时,宿主先把用户问题改写成 {zh,en},
 * 两条 query 各自只召回"同语言描述"的工具,两段**分开返回**(见 searchGrouped)。
 */
import { ToolRetriever, type BilingualQuery, type DescriptionLanguage, type Embedder, type RetrievalDoc } from "./retrieval.js";

/** 编目条目:内部持有完整 schema 与执行入口,只对外暴露名字/一行描述 */
export interface CatalogEntry {
	name: string;
	label?: string;
	description: string;
	/** 描述语言:决定它进哪一路召回(不填则按描述文本推断) */
	descriptionLanguage?: DescriptionLanguage;
	/** 来源:tool=目录工具 / workflow=已晋升工作流 / mcp=外部 MCP 工具 */
	origin: "tool" | "workflow" | "mcp";
	/** 完整参数 schema:只在 get_tool_details 时返回给模型 */
	parameters: unknown;
	execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
}

export interface CatalogSummaryItem {
	name: string;
	description: string;
}

export interface ToolCatalogOptions {
	/** 语义通道相似度下限,按描述语言分别配置(配置项 tools.catalog.semanticFloorZh / semanticFloorEn) */
	semanticFloors: { zh: number; en: number };
	/** 双语召回:每种语言各自返回多少条(配置项 tools.catalog.bilingual.perLanguageTopK) */
	perLanguageTopK: number;
	/** 向量化实现(测试注入用;默认本地 BGE) */
	embed?: Embedder;
}

const SUMMARY_MAX_CHARS = 120;

/** 一行摘要:压平空白并截断,保证编目结果足够轻 */
export function summarize(description: string): string {
	const flat = String(description ?? "").replace(/\s+/g, " ").trim();
	if (flat.length <= SUMMARY_MAX_CHARS) return flat;
	return flat.slice(0, SUMMARY_MAX_CHARS - 1) + "…";
}

export class ToolCatalog {
	private entries = new Map<string, CatalogEntry>();
	private options: ToolCatalogOptions;
	private retriever: ToolRetriever | null = null;

	constructor(options: ToolCatalogOptions) {
		this.options = options;
	}

	add(entry: CatalogEntry): void {
		this.entries.set(entry.name, entry);
		this.retriever = null; // 目录变了就重建索引(懒构建:search 时才建)
	}

	addMany(entries: CatalogEntry[]): void {
		for (const e of entries) this.add(e);
	}

	get size(): number {
		return this.entries.size;
	}

	has(name: string): boolean {
		return this.entries.has(name);
	}

	names(): string[] {
		return [...this.entries.keys()];
	}

	/** 各语言各有多少工具(日志/调试用) */
	countByLanguage(): Record<DescriptionLanguage, number> {
		return this.index().countByLanguage();
	}

	/** 单条 query 检索(改写未启用/失败时的路径):词面 + 语义融合 */
	async search(query: string, topK: number): Promise<CatalogSummaryItem[]> {
		return this.toItems(await this.index().search(String(query ?? ""), Math.max(1, topK)));
	}

	/**
	 * 生产入口:双语召回。{zh,en} 两条 query 各自只召回"同语言描述"的工具,**两段分开返回**,
	 * 不做跨语言混排 —— 跨语言的取舍交给模型按工具描述判断,否则只能按工具名去猜谁在前面
	 * (实测:混排时两段的第 1 名分数相同,按名字排序会让 mcp_* 压过 workflow_*,把中文工作流的 Top1 打到 0%)。
	 */
	async searchGrouped(queries: BilingualQuery, extraQuery?: string): Promise<{ zh: CatalogSummaryItem[]; en: CatalogSummaryItem[] }> {
		const grouped = await this.index().searchGrouped(queries, { perLanguageTopK: this.options.perLanguageTopK }, extraQuery);
		return { zh: this.toItems(grouped.zh), en: this.toItems(grouped.en) };
	}

	/** 取单个工具的完整定义(仅此时才把 parameters 暴露给模型) */
	details(name: string): { name: string; label?: string; description: string; parameters: unknown } | undefined {
		const entry = this.entries.get(String(name ?? "").trim());
		if (!entry) return undefined;
		return { name: entry.name, label: entry.label, description: entry.description, parameters: entry.parameters };
	}

	/** 执行:名字必须先存在于编目里(防止模型编造工具名) */
	async call(name: string, args: Record<string, unknown>, toolCallId = "catalog-call"): Promise<unknown> {
		const entry = this.entries.get(String(name ?? "").trim());
		if (!entry) throw new Error(`工具「${name}」不在可用工具清单里(请先用 search_tools 检索确切名称)`);
		return entry.execute(toolCallId, args ?? {});
	}

	private toItems(names: string[]): CatalogSummaryItem[] {
		return names.map((name) => ({ name, description: summarize(this.entries.get(name)?.description ?? "") }));
	}

	/** 检索索引:懒构建(索引文本 = 名称拆词 + 展示名 + 描述 + 参数名 + 分类) */
	private index(): ToolRetriever {
		if (!this.retriever) {
			const docs: RetrievalDoc[] = [...this.entries.values()].map((entry) => ({
				name: entry.name,
				label: entry.label,
				description: entry.description,
				descriptionLanguage: entry.descriptionLanguage,
				parameters: entry.parameters,
			}));
			this.retriever = new ToolRetriever(docs, { semanticFloors: this.options.semanticFloors, embed: this.options.embed });
		}
		return this.retriever;
	}
}