import type { DatabaseSync } from "node:sqlite";
import { appendMemory, memoryFilePath } from "./memory.js";
import { countReflectionCases, listReflectionCases } from "../repositories/reflection-cases.js";

export interface ReflectionSuggestion {
	topic: string;
	count: number;
	suggestion: string;
}

export interface ReflectionSummary {
	days: number;
	caseCounts: Array<{ caseType: string; count: number }>;
	suggestions: ReflectionSuggestion[];
}

/** 评估低分阈值:低于该分的评估进入反思案例。 */
export const EVALUATION_LOW_SCORE = 70;

/** 从反思案例聚合改进建议(纯聚合,无模型依赖)。 */
export function collectReflectionSuggestions(db: DatabaseSync, tenantId: string, days = 7): ReflectionSummary {
	const caseCounts = countReflectionCases(db, tenantId, days).map((r) => ({ caseType: r.case_type, count: r.count }));
	const suggestions: ReflectionSuggestion[] = [];

	// 话术评估低分:按共性可改进点聚合
	const evalCases = listReflectionCases(db, tenantId, { caseType: "evaluation_low", days });
	const improvementFreq = new Map<string, number>();
	for (const c of evalCases) {
		try {
			const d = c.detailJson ? (JSON.parse(c.detailJson) as { improvements?: string[]; score?: number }) : {};
			const dims = (d.improvements ?? []).filter((x: unknown) => typeof x === "string");
			for (const imp of dims.slice(0, 3)) {
				const key = imp.replace(/\s+/g, " ").slice(0, 50);
				improvementFreq.set(key, (improvementFreq.get(key) ?? 0) + 1);
			}
		} catch {
			// 忽略
		}
	}
	for (const [topic, count] of [...improvementFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
		suggestions.push({
			topic,
			count,
			suggestion: `近 ${days} 天 ${count} 次话术评估指出该问题,建议在话术库补充对应场景的规范表达,并在销售培训中专项练习。`,
		});
	}

	// 运行失败:按错误信息聚合
	const runCases = listReflectionCases(db, tenantId, { caseType: "run_failed", days });
	if (runCases.length > 0) {
		suggestions.push({
			topic: "Agent 运行失败",
			count: runCases.length,
			suggestion: `近 ${days} 天有 ${runCases.length} 次 Agent 运行失败(如无最终答复/接口异常),建议检查模型端点可用性与提示词收口约束。`,
		});
	}

	return { days, caseCounts, suggestions };
}

/** 把反思建议写入 memory.md「规则改进」小节,形成闭环(去重,限量)。 */
export function applyReflectionToMemory(db: DatabaseSync, tenantId: string, days = 7, filePath = memoryFilePath()): ReflectionSummary {
	const summary = collectReflectionSuggestions(db, tenantId, days);
	let applied = 0;
	for (const s of summary.suggestions) {
		try {
			appendMemory(filePath, "规则改进", `反思建议:${s.topic}(${s.count}) ${s.suggestion}`);
			applied++;
		} catch (error) {
			console.warn(`[reflection] 写入记忆失败: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { ...summary, caseCounts: summary.caseCounts, suggestions: summary.suggestions.slice(0, applied) };
}