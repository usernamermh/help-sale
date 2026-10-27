import { describe, expect, it } from "vitest";
import { getSalesAgentSystemPrompt } from "./sales-agent.js";

describe("sales-agent prompt", () => {
	it("工具说明不拼接进系统提示词,保留【工具调用】引导", () => {
		const prompt = getSalesAgentSystemPrompt({ companyName: "智造云", teamName: "销售团队" });
		expect(prompt).toContain("【工具调用】");
		expect(prompt).not.toContain("【外部工具】");
		expect(prompt).not.toContain("main.createTodoList");
		expect(prompt).not.toContain("(tools_system/");
		expect(prompt).toContain("【系统记忆】");
		expect(prompt).toContain("## 工具经验");
	});

	it("包含图表美观规范", () => {
		const prompt = getSalesAgentSystemPrompt();
		expect(prompt).toContain("图表规范");
		expect(prompt).toContain("类型匹配数据");
	});

	it("表格分页规则:表格类工具每页最多 10 行", () => {
		const prompt = getSalesAgentSystemPrompt();
		expect(prompt).toContain("每页最多 10 行");
		expect(prompt).toContain("前端表格翻页按钮");
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