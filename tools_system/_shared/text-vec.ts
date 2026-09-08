/** 无依赖轻量文本向量/聚类/关键词能力:字符 n-gram 哈希向量(L2 归一化)+ KMeans + 词频关键词。 */

export const VEC_DIM = 256;

/** 清洗文本:保留中英文与数字,统一小写,去除标点/空白。 */
export function cleanText(text: string): string {
	return text
		.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, " ")
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim();
}

/** 字符 n-gram 哈希向量:固定维度稀疏特征,L2 归一化。 */
export function textVector(text: string, dim = VEC_DIM): number[] {
	const vec = new Array<number>(dim).fill(0);
	const t = cleanText(text);
	if (!t) return vec;
	for (let n = 2; n <= 3; n++) {
		for (let i = 0; i + n <= t.length; i++) {
			let h = 0;
			for (let j = 0; j < n; j++) h = (h * 31 + (t.charCodeAt(i + j) || 0)) >>> 0;
			vec[h % dim] += 1;
		}
	}
	const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
	return vec.map((v) => v / norm);
}

export function cosineSim(a: number[], b: number[]): number {
	if (a.length !== b.length) return 0;
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	if (na === 0 || nb === 0) return 0;
	return dot / Math.sqrt(na * nb);
}

/** KMeans 聚类:返回每点所属簇索引(0..k-1)与簇内样本数。 */
export function kmeans(points: number[][], k: number, maxIter = 20): { assignments: number[]; sizes: number[] } {
	const n = points.length;
	if (n === 0) return { assignments: [], sizes: [] };
	const kk = Math.max(1, Math.min(k, n));
	let centers: number[][] = points.slice(0, kk).map((p) => [...p]);
	const assignments = new Array<number>(n).fill(0);
	for (let iter = 0; iter < maxIter; iter++) {
		let changed = false;
		for (let i = 0; i < n; i++) {
			let best = 0;
			let bestSim = -Infinity;
			for (let c = 0; c < kk; c++) {
				const sim = cosineSim(points[i], centers[c]);
				if (sim > bestSim) {
					bestSim = sim;
					best = c;
				}
			}
			if (assignments[i] !== best) {
				assignments[i] = best;
				changed = true;
			}
		}
		if (!changed) break;
		// 重算中心
		const sums = Array.from({ length: kk }, () => new Array<number>(points[0].length).fill(0));
		const counts = new Array<number>(kk).fill(0);
		for (let i = 0; i < n; i++) {
			counts[assignments[i]]++;
			for (let d = 0; d < points[i].length; d++) sums[assignments[i]][d] += points[i][d];
		}
		for (let c = 0; c < kk; c++) {
			if (counts[c] > 0) {
				for (let d = 0; d < points[0].length; d++) centers[c][d] = sums[c][d] / counts[c];
			}
		}
	}
	const sizes = new Array<number>(kk).fill(0);
	for (const a of assignments) sizes[a]++;
	return { assignments, sizes };
}

const STOP_WORDS = new Set([
	"一个", "这个", "那个", "什么", "怎么", "可以", "就是", "还是", "但是", "因为", "所以", "如果", "我们", "你们", "他们", "自己",
	"知道", "觉得", "没有", "不是", "比较", "非常", "一些", "这样", "那样", "之后", "现在", "今天", "明天", "时候", "问题", "东西",
	"一下", "的话", "然后", "其实", "应该", "可能", "已经", "还有", "或者", "需要", "价格", "时间", "客户", "销售", "车型", "这款",
	"这个", "一下", "什么", "可以", "觉得", "请问", "您好", "谢谢", "不用", "那个", "的话", "意思", "情况", "方面",
]);

/** 简单中文关键词抽取:2-6 字滑动窗口词频,过滤停用词后取 Top N。 */
export function extractKeywords(text: string, max = 5): string[] {
	const t = cleanText(text);
	if (!t) return [];
	const freq = new Map<string, number>();
	for (let n = 2; n <= 6; n++) {
		for (let i = 0; i + n <= t.length; i++) {
			const gram = t.slice(i, i + n);
			if (STOP_WORDS.has(gram) || /^[\dA-Za-z]+$/.test(gram) && n < 4) continue;
			freq.set(gram, (freq.get(gram) ?? 0) + 1);
		}
	}
	return [...freq.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)
		.slice(0, max)
		.map(([gram]) => gram);
}