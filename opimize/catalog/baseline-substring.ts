/**
 * 旧方案复刻:裸子串 + 词边界打分的编目检索(就是"创建issue 命中 issue、is 也命中 issue"的那一版)。
 *
 * 仅作为离线评测的对照基准存在,生产代码里已经删掉这一版(mcp/catalog.ts 现在走词面+语义双通道)。
 * 保留它才能拿出"换方案前 / 换方案后"的可比数字,而不是只凭感觉说新方案更好。
 */
import type { RetrievalDoc } from "../../backend/mcp/retrieval.js";

const STOPWORDS = new Set([
	"a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "does", "for", "from", "how", "i", "in", "is", "it",
	"me", "my", "of", "on", "or", "please", "the", "this", "that", "to", "use", "was", "what", "when", "where", "which",
	"who", "why", "with", "you", "your",
]);
const CJK_STOPWORDS = new Set(["的", "了", "和", "与", "是", "在", "把", "给", "请", "帮我", "一下", "怎么", "如何", "什么", "这个", "那个", "他", "她", "它"]);
const MIN_ASCII_TOKEN = 3;
const ASCII = /[a-z0-9]/;
const CJK = /[\u4e00-\u9fa5]/;

function tokenizeQuery(text: string): string[] {
	const lower = String(text ?? "").toLowerCase();
	const runs = lower.match(/[a-z0-9]+|[\u4e00-\u9fa5]+/g) ?? [];
	const tokens = new Set<string>();
	for (const run of runs) {
		if (ASCII.test(run[0] ?? "")) {
			if (run.length >= MIN_ASCII_TOKEN && !STOPWORDS.has(run)) tokens.add(run);
			continue;
		}
		if (CJK.test(run[0] ?? "")) {
			if (run.length === 1) {
				if (!CJK_STOPWORDS.has(run)) tokens.add(run);
				continue;
			}
			for (let i = 0; i + 2 <= run.length; i++) {
				const bigram = run.slice(i, i + 2);
				if (!CJK_STOPWORDS.has(bigram)) tokens.add(bigram);
			}
		}
	}
	return [...tokens];
}

function wordsOf(text: string): Set<string> {
	return new Set(String(text ?? "").toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/).filter(Boolean));
}

/** 旧方案检索:返回命中工具名(score>0 的按分数降序) */
export function legacySearch(docs: RetrievalDoc[], query: string, topK: number): string[] {
	const q = String(query ?? "").trim().toLowerCase();
	if (!q) return [];
	const tokens = tokenizeQuery(q);
	if (tokens.length === 0) return [];

	const df = new Map<string, number>();
	const prepared = docs.map((doc) => {
		const name = doc.name.toLowerCase();
		const label = (doc.label ?? "").toLowerCase();
		const description = String(doc.description ?? "").toLowerCase();
		const nameWords = new Set([...wordsOf(doc.name), ...wordsOf(doc.label ?? "")]);
		const descWords = wordsOf(doc.description);
		for (const token of tokens) if (nameWords.has(token) || descWords.has(token)) df.set(token, (df.get(token) ?? 0) + 1);
		return { doc, name, label, description, nameWords, descWords };
	});
	const dfCutoff = Math.max(2, Math.ceil(prepared.length * 0.25));

	const scored: Array<{ name: string; score: number }> = [];
	for (const { doc, name, label, description, nameWords, descWords } of prepared) {
		let score = 0;
		if (name === q || label === q) score += 1000;
		else if (name.includes(q) || label.includes(q)) score += 500;
		else if (q.includes(name)) score += 300;
		for (const token of tokens) {
			if ((df.get(token) ?? 0) > dfCutoff) continue;
			if (nameWords.has(token)) score += 80;
			else if (token.length >= 4 && name.includes(token)) score += 40;
			if (descWords.has(token)) score += 20;
			else if (CJK.test(token) && (description.includes(token) || name.includes(token) || label.includes(token))) score += 20;
		}
		if (score > 0) scored.push({ name: doc.name, score });
	}
	return scored
		.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
		.slice(0, Math.max(1, topK))
		.map((s) => s.name);
}