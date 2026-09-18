import { cosineSim } from "../_shared/text-vec.js";
import { embedTextsSafe } from "../_shared/bge-embed.js";

interface ToolContext { db: any; tenantId: string; }

/** 语义相似度匹配:对每条 query 在 targets 中取 top-k 余弦相似度结果(字符 n-gram 向量,无外部依赖)。 */
export async function execute(_ctx: ToolContext, params: any) {
	const queries = (Array.isArray(params?.queries) ? params.queries : typeof params?.queries === "string" ? [params.queries] : [])
		.map((s: unknown) => String(s ?? ""))
		.filter((s: string) => s.trim().length > 0);
	const targets = (Array.isArray(params?.targets) ? params.targets : typeof params?.targets === "string" ? [params.targets] : [])
		.map((s: unknown) => String(s ?? ""))
		.filter((s: string) => s.trim().length > 0);
	if (queries.length === 0 || targets.length === 0) {
		return { content: [{ type: "text", text: "需要 queries 与 targets(字符串或字符串数组)。" }] };
	}
	const topK = Math.max(1, Math.min(Number(params?.topK ?? 3) || 3, targets.length));
	const threshold = Number(params?.threshold ?? 0) || 0;
	const qVecs = await embedTextsSafe(queries);
	const tVecs = await embedTextsSafe(targets);
	const matches = queries.map((q, qi) => {
		const scores = tVecs.map((tv, ti) => ({ index: ti, text: targets[ti], score: cosineSim(qVecs[qi], tv) }));
		scores.sort((a, b) => b.score - a.score);
		const hits = scores.filter((s) => s.score >= threshold).slice(0, topK);
		return { queryIndex: qi, query: q, hits };
	});
	const total = matches.reduce((s, m) => s + m.hits.length, 0);
	return {
		content: [{ type: "text", text: `已完成 ${queries.length} 条查询 × ${targets.length} 条目标的余弦相似度匹配:命中 ${total} 条(阈值 ${threshold},每查询 topK ${topK})。` }],
		details: { count: queries.length, targetCount: targets.length, topK, threshold, matches },
	};
}
