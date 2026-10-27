import { describe, expect, it } from "vitest";
import { toClientEvents } from "./events-adapter.js";

describe("toClientEvents", () => {
	it("tool_execution_end 映射为 tool_end", () => {
		const events = toClientEvents({
			type: "tool_execution_end",
			toolCallId: "tc-1",
			toolName: "emit_analysis",
			result: { ok: true },
			isError: false,
		});
		expect(events).toEqual([{ type: "tool_end", toolCallId: "tc-1", toolName: "emit_analysis", payload: { ok: true } }]);
	});

	it("turn_* 事件被过滤", () => {
		expect(toClientEvents({ type: "turn_start" as never })).toEqual([]);
	});

	it("message_update 携带 text_delta 时转发为 text_delta", () => {
		const events = toClientEvents({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "你好，" },
			message: { role: "assistant", content: [{ type: "text", text: "你好，" }] },
		} as never);
		expect(events).toEqual([{ type: "text_delta", payload: { text: "你好，" } }]);
	});

	it("message_update 非文本增量保持原样透传", () => {
		const events = toClientEvents({
			type: "message_update",
			assistantMessageEvent: { type: "toolcall_delta", delta: "{}" },
			message: { role: "assistant" },
		} as never);
		expect(events[0]?.type).toBe("message_update");
	});
});
