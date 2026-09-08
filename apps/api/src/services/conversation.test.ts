import { describe, expect, it } from "vitest";
import { normalizeAnalyzeMessages, parseTranscript } from "./conversation.js";

describe("parseTranscript", () => {
	it("按前缀标注识别发言人", () => {
		const msgs = parseTranscript("客户:旗舰版多少钱?\n销售:您好,聊聊预算?\n客户:预算1500");
		expect(msgs.map((m) => m.role)).toEqual(["customer", "sales", "customer"]);
		expect(msgs[0].content).toBe("旗舰版多少钱?");
	});

	it("无前缀按首条客户、之后交替", () => {
		const msgs = parseTranscript("价格多少?\n大概1500\n可以看看");
		expect(msgs.map((m) => m.role)).toEqual(["customer", "sales", "customer"]);
	});

	it("混合前缀与无前缀行", () => {
		const msgs = parseTranscript("客户:在吗\n在的,您说\n你们这个支持私有化吗");
		expect(msgs.map((m) => m.role)).toEqual(["customer", "sales", "customer"]);
	});

	it("空文本返回空数组", () => {
		expect(parseTranscript("  \n\n")).toEqual([]);
	});
});

describe("normalizeAnalyzeMessages", () => {
	it("messages 优先于 transcript", () => {
		const msgs = normalizeAnalyzeMessages({
			transcript: "客户:旧文本",
			messages: [{ role: "sales", content: "新内容" }, { role: "customer", content: "另一条" }],
		});
		expect(msgs).toEqual([
			{ role: "sales", content: "新内容" },
			{ role: "customer", content: "另一条" },
		]);
	});

	it("无 messages 时解析 transcript", () => {
		const msgs = normalizeAnalyzeMessages({ transcript: "客户:在吗\n销售:在的" });
		expect(msgs.map((m) => m.role)).toEqual(["customer", "sales"]);
	});

	it("未知 role 归为客户", () => {
		const msgs = normalizeAnalyzeMessages({ messages: [{ role: "boss", content: "x" }] });
		expect(msgs[0]).toEqual({ role: "customer", content: "x" });
	});

	it("两个都为空返回空数组", () => {
		expect(normalizeAnalyzeMessages({})).toEqual([]);
	});
});