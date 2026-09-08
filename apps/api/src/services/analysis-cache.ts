import { createHash } from "node:crypto";
import { stableStringify } from "./stable-json.js";

export interface AnalysisHashMessage {
	role: string;
	content: string;
	spokenAt?: string;
}

export interface AnalysisHashContext {
	customerKey?: string;
	customerName?: string;
	customerPhone?: string;
	salesId?: string;
	salesName?: string;
	salesPhone?: string;
	storeId?: string;
	conversationId?: string;
}

/** 相同对话原文 + 上下文 => 相同请求哈希,用于分析结果缓存(命中后不再调用模型)。 */
export function analysisRequestHash(input: AnalysisHashContext & { messages: AnalysisHashMessage[] }): string {
	return createHash("sha256").update(stableStringify(input)).digest("hex");
}