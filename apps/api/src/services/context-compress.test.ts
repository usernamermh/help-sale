import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../db/database.js";
import { requireTenant } from "../repositories/customers.js";
import { createThread, appendThreadMessage } from "../repositories/agent-threads.js";
import { getThreadSummary } from "../repositories/thread-summaries.js";
import { buildSummaryText, compressHistory, ensureThreadSummary } from "./context-compress.js";

let db: DatabaseSync;
beforeEach(() => {
	db = openDatabase(":memory:");
	requireTenant(db, "t1", "演示租户");
});
afterEach(() => db.close());

describe("上下文压缩与记忆分层", () => {
	it("history 超长时压缩早期对话为摘要,保留最近 N 条", () => {
		const history = Array.from({ length: 40 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user"), content: `第${i + 1}轮内容` }));
		const { summary, messages } = compressHistory(history, { maxMessages: 30 });
		expect(summary).toContain("用户目标");
		expect(messages).toHaveLength(31); // 摘要消息 + 最近 30 条
		expect(messages[0].role).toBe("user");
		expect(messages[0].content).toContain("【历史摘要】");
		expect(messages[1].content).toContain("第11轮");
	});

	it("history 未超长时不压缩", () => {
		const history = Array.from({ length: 5 }, (_, i) => ({ role: "user", content: `g${i}` }));
		const { summary, messages } = compressHistory(history, { maxMessages: 30 });
		expect(summary).toBe("");
		expect(messages).toHaveLength(5);
	});

	it("规则摘要抽取用户目标与近期结论", () => {
		const summary = buildSummaryText([
			{ role: "user", content: "查一下陈静的跟进情况,并准备报价方案" },
			{ role: "assistant", content: "陈静预算 20-30 万,建议汉EV 冠军版" },
		]);
		expect(summary).toContain("陈静");
		expect(summary).toContain("汉EV");
	});

	it("ensureThreadSummary 生成并落库摘要", () => {
		const thread = createThread(db, "t1");
		appendThreadMessage(db, "t1", thread.id, "user", [{ type: "text", text: "帮我分析今天会话" }]);
		appendThreadMessage(db, "t1", thread.id, "assistant", [{ type: "text", text: "今日有 5 次分析,价格异议为主" }]);
		const summary = ensureThreadSummary(db, "t1", thread.id);
		expect(summary).toContain("今日");
		const stored = getThreadSummary(db, "t1", thread.id)!;
		expect(stored.summary).toBe(summary);
		expect(stored.messageSeqUntil).toBe(2);
	});
});