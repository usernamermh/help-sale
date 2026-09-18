import { describe, expect, it } from "vitest";
import { getSalesAgentSystemPrompt } from "./sales-agent.js";

describe("sales-agent prompt", () => {
	it("工具经函数调用(tools 字段)注册,不再拼接进系统提示词", () => {
		const prompt = getSalesAgentSystemPrompt({ companyName: "智造云", teamName: "销售团队" });
		expect(prompt).toContain("【工具调用】");
		expect(prompt).toContain("tools 字段");
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

	it("明确禁止模型输出 Markdown 表格", () => {
		const prompt = getSalesAgentSystemPrompt();
		expect(prompt).toContain("禁止在最终答复中输出任何 Markdown 表格");
		expect(prompt).toContain("一律由工具返回");
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