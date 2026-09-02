import type { DatabaseSync } from "node:sqlite";
import { upsertCustomerTag } from "../repositories/customer-tags.js";

export interface AnalysisTagInput {
	intent: string;
	signals: Array<{ kind?: string; quote?: string; note?: string }>;
}


const INTENT_MAP: Array<[string, string]> = [
	["价格异议", "价格敏感"],
	["竞品", "竞品对比"],
	["需求确认", "需求确认"],
	["催促", "急切决策"],
	["对比", "竞品对比"],
	["流失", "流失风险"],
];

const SIGNAL_KIND_MAP: Array<[string, string]> = [
	["budget", "价格敏感"],
	["competitor", "竞品对比"],
	["buying_signal", "高意向"],
	["risk", "流失风险"],
	["pain_point", "痛点明确"],
];

/** 从一次分析确定性抽取标签集合(去重)。 */
export function extractTagsFromAnalysis(input: AnalysisTagInput): string[] {
	const tags = new Set<string>();
	const intent = input.intent ?? "";
	for (const [keyword, tag] of INTENT_MAP) {
		if (intent.includes(keyword)) tags.add(tag);
	}
	for (const signal of input.signals ?? []) {
		if (!signal.kind) continue;
		for (const [kind, tag] of SIGNAL_KIND_MAP) {
			if (signal.kind === kind) tags.add(tag);
		}
	}
	return [...tags];
}

/** 分析落库后刷新客户标签(权重累加)。source 用分析 id 去重同一来源。 */
export function refreshCustomerTags(
	db: DatabaseSync,
	input: { tenantId: string; customerId: string; analysisId: string; intent: string; signals: Array<{ kind?: string; quote?: string; note?: string }> },
): string[] {
	const tags = extractTagsFromAnalysis(input);
	for (const tag of tags) {
		upsertCustomerTag(db, { tenantId: input.tenantId, customerId: input.customerId, tag, source: `analysis:${input.analysisId}` });
	}
	return tags;
}