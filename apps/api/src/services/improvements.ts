import type { DatabaseSync } from "node:sqlite";
import { config } from "../env.js";

export interface ImprovementSuggestion {
	topic: string;
	count: number;
	reason: string;
	suggestion: string;
}

export interface Improvements {
	days: number;
	generatedAt: string;
	analyses: number;
	rejectedCandidates: number;
	suggestions: ImprovementSuggestion[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 规则改进 SOP(对标参考包 rule_improvement_sop):
 * 从近 N 天的分析(流失风险信号)与被拒知识候选中聚合出可执行的改进建议。
 * 纯聚合,无模型依赖,快速稳定。
 */
export function collectImprovements(db: DatabaseSync, input: { tenantId: string; days?: number; now?: Date }): Improvements {
	const days = Math.min(Math.max(input.days ?? 30, 1), 90);
	const now = input.now ?? new Date();
	const since = new Date(now.getTime() - days * DAY_MS);

	const analyses = db
		.prepare("SELECT intent, signals_json FROM analyses WHERE tenant_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 200")
		.all(input.tenantId, since.toISOString()) as Array<{ intent: string; signals_json: string }>;

	// 统计含流失风险(risk)信号的场景
	const riskByIntent = new Map<string, number>();
	for (const row of analyses) {
		let signals: Array<{ kind?: string }> = [];
		try {
			signals = JSON.parse(row.signals_json) as Array<{ kind?: string }>;
		} catch {
			// 忽略解析失败
		}
		if (signals.some((s) => s.kind === "risk")) {
			const intent = (row.intent || "通用").slice(0, 40);
			riskByIntent.set(intent, (riskByIntent.get(intent) ?? 0) + 1);
		}
	}

	const rejected = db.prepare("SELECT COUNT(*) AS n FROM knowledge_candidates WHERE tenant_id = ? AND status = 'rejected'").get(input.tenantId) as { n: number };

	const suggestions: ImprovementSuggestion[] = [];
	for (const [intent, count] of [...riskByIntent.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
		suggestions.push({
			topic: `${intent} · 流失风险`,
			count,
			reason: `近 ${days} 天 ${count} 次分析检出流失风险信号`,
			suggestion:
				"建议补强该场景话术:先复述客户顾虑/预算锚点,再用差异化价值(功能/服务/交付)替代直接谈价,并明确约下一步动作。",
		});
	}
	if (rejected.n > 0) {
		suggestions.push({
			topic: "知识沉淀流失",
			count: rejected.n,
			reason: `${rejected.n} 条话术候选未被采纳`,
			suggestion: "建议复盘被拒候选:是话术质量问题还是入库标准问题;被拒原因可作为质检规则输入。",
		});
	}
	if (suggestions.length > 0) {
		suggestions.push({
			topic: "跟进时效",
			count: suggestions.reduce((sum, s) => sum + s.count, 0),
			reason: "基于以上改进项合计出现次数",
			suggestion: "将以上改进点写入团队话术评审,下一周期晨报跟踪复现率是否下降。",
		});
	}

	return {
		days,
		generatedAt: now.toISOString(),
		analyses: analyses.length,
		rejectedCandidates: rejected.n,
		suggestions,
	};
}