import { describe, expect, it } from "vitest";
import { getCopilotSystemPrompt } from "./sales-copilot.js";

describe("getCopilotSystemPrompt", () => {
	it("包含角色与工具纪律", () => {
		const p = getCopilotSystemPrompt({ companyName: "智造云" });
		expect(p).toContain("销售军师");
		expect(p).toContain("emit_analysis");
		expect(p).toContain("knowledge_search");
		expect(p).toContain("智造云");
	});
});