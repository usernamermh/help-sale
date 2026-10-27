/** 长对话上下文压缩(早期消息摘要) */
import type { DatabaseSync } from "node:sqlite";
import { listThreadMessages } from "../integrations_pi/tables/agents/threads.js";
import { upsertThreadSummary, getThreadSummary } from "../integrations_pi/tables/agents/summaries.js";
import { config } from "../env.js";

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

/** 粗略 token 估算:中文按字符/1.5、英文按 4 字符/token,消息条数也有基础开销。 */
export function estimateTokens(messages: Array<{ role?: string; content?: unknown }>): number {
	let tokens = 0;
	for (const m of messages) {
		const text = messageText(m.content);
		const cjk = (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) ?? []).length;
		const other = text.length - cjk;
		tokens += Math.ceil(cjk / 1.5) + Math.ceil(other / 4) + 4; // 每条消息的 role/结构开销
	}
	return tokens;
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
 * 保留此函数兼容旧调用与测试;新代码请使用 buildContextForThread(增量游标版)。
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

/** 压缩阈值:按模型上下文窗口的比例计算,同时受消息条数下限保护。 */
export function shouldCompress(messages: Array<{ role?: string; content?: unknown }>): boolean {
	if (messages.length < config.compressionMinMessages) return false;
	const thresholdTokens = Math.floor(config.modelContextWindow * config.compressionThresholdRatio);
	return estimateTokens(messages) > thresholdTokens;
}

/**
 * 增量构建会话上下文(游标版):
 * - 读取 thread_summaries.message_seq_until 作为已压缩游标;
 * - 只取游标之后的新消息 + 旧摘要消息,避免重复压缩;
 * - 若新消息总 token 超阈值,则保护开头 keepHead 条与最近 keepTail 条,压缩中间部分;
 * - 返回 { messages, summary, summarizedUntil }。
 */
export function buildContextForThread(
	db: DatabaseSync,
	tenantId: string,
	threadId: string,
	extra?: { goal?: string },
): { messages: Array<{ role: string; content: unknown }>; summary: string; summarizedUntil: number } {
	const rows = listThreadMessages(db, tenantId, threadId);
	const all = rows.filter((m) => m.role === "user" || m.role === "assistant").map((m) => ({ role: m.role, content: m.content }));
	const stored = getThreadSummary(db, tenantId, threadId);
	const summarizedUntil = stored?.messageSeqUntil ?? 0;

	// 新消息 = seq 大于游标的消息
	const newRows = rows.filter((m) => m.seq > summarizedUntil);
	const newMessages = newRows.filter((m) => m.role === "user" || m.role === "assistant").map((m) => ({ role: m.role, content: m.content }));
	// 若没有旧摘要且消息总量超阈值,则全量作为"待压缩"输入
	const pending = stored?.summary ? newMessages : all;
	const priorSummary = stored?.summary;

	let summary = priorSummary ?? "";
	let messages: Array<{ role: string; content: unknown }> = [];

	if (pending.length === 0) {
		// 没有新消息,直接返回摘要(若有)
		if (priorSummary) {
			messages = [{ role: "user", content: `【历史摘要】\n${priorSummary}` }];
		}
		if (extra?.goal) messages = [...messages, { role: "user", content: extra.goal }];
		return { messages, summary, summarizedUntil };
	}

	const needCompress = shouldCompress(pending);
	if (needCompress && pending.length > config.compressionKeepHead + config.compressionKeepTail) {
		const head = pending.slice(0, config.compressionKeepHead);
		const tail = pending.slice(-config.compressionKeepTail);
		const middle = pending.slice(config.compressionKeepHead, pending.length - config.compressionKeepTail);
		const middleSummary = buildSummaryText(middle, config.compressionMaxSummaryChars);
		// 增量累积:旧摘要 + 新压缩出的中间摘要
		summary = [priorSummary, middleSummary].filter(Boolean).join("\n");
		messages = [
			...(priorSummary ? [{ role: "user", content: `【历史摘要】\n${priorSummary}` }] : []),
			...head,
			{ role: "user", content: `【历史摘要】\n${middleSummary}` },
			...tail,
		];
	} else {
		// 未超阈值:保留旧摘要 + 全部新消息
		messages = [
			...(priorSummary ? [{ role: "user", content: `【历史摘要】\n${priorSummary}` }] : []),
			...pending,
		];
	}
	if (extra?.goal) messages = [...messages, { role: "user", content: extra.goal }];

	// 新消息的最后一个 seq 作为下次游标
	const lastNewSeq = newRows.length ? newRows[newRows.length - 1].seq : summarizedUntil;

	// 压缩后立即落库(推进游标),避免下一轮把同一批消息当新消息重复压缩
	if (needCompress && summary !== priorSummary) {
		upsertThreadSummary(db, { tenantId, threadId, summary, messageSeqUntil: Math.max(summarizedUntil, lastNewSeq) });
	}
	return { messages, summary, summarizedUntil: Math.max(summarizedUntil, lastNewSeq) };
}

/** 生成并落库 thread 摘要(增量:只总结游标之后的新消息,累积旧摘要)。 */
export function ensureThreadSummary(db: DatabaseSync, tenantId: string, threadId: string): string {
	const rows = listThreadMessages(db, tenantId, threadId);
	const stored = getThreadSummary(db, tenantId, threadId);
	const summarizedUntil = stored?.messageSeqUntil ?? 0;
	const newRows = rows.filter((m) => m.seq > summarizedUntil);
	const newMessages = newRows.filter((m) => m.role === "user" || m.role === "assistant").map((m) => ({ role: m.role, content: m.content }));

	const prior = stored?.summary ?? "";
	const fresh = newMessages.length > 0 ? buildSummaryText(newMessages, config.compressionMaxSummaryChars) : "";
	const summary = [prior, fresh].filter(Boolean).join("\n") || "对话暂无有效内容";
	const lastSeq = rows.length ? rows[rows.length - 1].seq : summarizedUntil;
	upsertThreadSummary(db, { tenantId, threadId, summary, messageSeqUntil: lastSeq });
	return summary;
}