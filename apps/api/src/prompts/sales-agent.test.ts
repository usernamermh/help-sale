import { describe, expect, it } from "vitest";
import { getSalesAgentSystemPrompt } from "./sales-agent.js";

describe("sales-agent prompt", () => {
	it("自动拼接 tools / tools_system 目录的外部工具(readme.json)", () => {
		const prompt = getSalesAgentSystemPrompt({ companyName: "智造云", teamName: "销售团队" });
		expect(prompt).toContain("【外部工具】");
		expect(prompt).toContain("todo_list");
		expect(prompt).toContain("创建、细化、标记完成 todo list");
		expect(prompt).toContain("main.createTodoList");
		expect(prompt).toContain("date_tool");
		expect(prompt).toContain("【系统记忆】");
		expect(prompt).toContain("## 工具经验");
		expect(prompt).toContain("data.mode");
	});


	it("表格分页规则:默认只展示第 1 页,禁止自动翻页取全量", () => {
		const prompt = getSalesAgentSystemPrompt();
		expect(prompt).toContain("每页最多 10 行");
		expect(prompt).toContain("禁止自动连续翻页");
		expect(prompt).toContain("用户明确要求");
	});

	it("模板不再残留 SYSTEM_TOOLS/TASKS_TOOLS 占位符", () => {
		const prompt = getSalesAgentSystemPrompt();
		expect(prompt).not.toContain("SYSTEM_TOOLS");
		expect(prompt).not.toContain("TASKS_TOOLS");
	});
});