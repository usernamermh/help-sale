import type { DatabaseSync } from "node:sqlite";
import { listThreadMessages } from "../repositories/agent-threads.js";
import { upsertThreadSummary } from "../repositories/thread-summaries.js";

/** 记忆分层:短期=当前轮次+最近消息;中期=会话摘要(thread_summaries);长期=memory.md+知识库+客户档案。 */

/** 提取消息文本(兼容 string 与 TextContent[])。 */
export function messageText(content: unknown): string {
	if (!content) return "";
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((c) => {
				const item = c as { type?: string; text?: string };
				return typeof item?.text === "string" ? item.text : "";
			})
			.join(" ");
	}
	return "";
}

/** 规则摘要:前部用户目标 + 关键中间结论,不依赖模型,稳定可测。 */
export function buildSummaryText(messages: Array<{ role: string; content: unknown }>, maxChars = 600): string {
	const userGoals: string[] = [];
	const tails: string[] = [];
	for (const m of messages) {
		const text = messageText(m.content).trim();
		if (!text) continue;
		if (m.role === "user") {
			const goal = text.replace(/\s+/g, " ").slice(0, 80);
			if (!userGoals.includes(goal)) userGoals.push(goal);
		} else if (m.role === "assistant") {
			tails.push(text.replace(/\s+/g, " ").slice(0, 120));
		}
	}
	const parts: string[] = [];
	if (userGoals.length) parts.push("用户目标:" + userGoals.slice(0, 8).join("; "));
	if (tails.length) parts.push("近期结论:" + tails.slice(-3).join(" | "));
	const summary = parts.join("\n").slice(0, maxChars);
	return summary || "对话暂无有效内容";
}

/**
 * 上下文压缩:history 超过 maxMessages 时,把最早部分压缩成摘要消息注入,保留最近 maxMessages 条原文。
 * 返回 { summary, messages }。
 */
export function compressHistory(
	history: Array<{ role: string; content: unknown }>,
	opts: { maxMessages?: number; summaryPrefix?: string } = {},
): { summary: string; messages: Array<{ role: string; content: unknown }> } {
	const maxMessages = opts.maxMessages ?? 30;
	if (history.length <= maxMessages) return { summary: "", messages: history };
	const kept = history.slice(-maxMessages);
	const dropped = history.slice(0, history.length - maxMessages);
	const summary = buildSummaryText(dropped);
	const summaryMessage: { role: string; content: unknown } = {
		role: "user",
		content: `${opts.summaryPrefix ?? "【历史摘要】早期对话已压缩,仅保留要点;基于它继续,不要重复询问已确认信息。"}\n${summary}`,
	};
	return { summary, messages: [summaryMessage, ...kept] };
}

/** 生成并落库 thread 摘要(基于全部 user/assistant 消息)。 */
export function ensureThreadSummary(db: DatabaseSync, tenantId: string, threadId: string): string {
	const rows = listThreadMessages(db, tenantId, threadId);
	const messages = rows.filter((m) => m.role === "user" || m.role === "assistant");
	const summary = buildSummaryText(messages.map((m) => ({ role: m.role, content: m.content })));
	const lastSeq = rows.length ? rows[rows.length - 1].seq : 0;
	upsertThreadSummary(db, { tenantId, threadId, summary, messageSeqUntil: lastSeq });
	return summary;
}