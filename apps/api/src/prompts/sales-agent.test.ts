import { describe, expect, it } from "vitest";
import { getSalesAgentSystemPrompt } from "./sales-agent.js";

describe("sales-agent prompt", () => {
	it("自动拼接 tools / tools_system 目录的外部工具(readme.json)", () => {
		const prompt = getSalesAgentSystemPrompt({ companyName: "智造云", teamName: "销售团队" });
		expect(prompt).toContain("【外部工具】");
		expect(prompt).toContain("todo_list");
		expect(prompt).toContain("创建、细化、标记完成 todo list");
		expect(prompt).toContain("main.createTodoList");
		expect(prompt).toContain("week2date");
		expect(prompt).toContain("操作 MySQL");
	});

	it("模板不再残留 SYSTEM_TOOLS/TASKS_TOOLS 占位符", () => {
		const prompt = getSalesAgentSystemPrompt();
		expect(prompt).not.toContain("SYSTEM_TOOLS");
		expect(prompt).not.toContain("TASKS_TOOLS");
	});
});