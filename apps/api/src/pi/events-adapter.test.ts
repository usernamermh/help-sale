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
});