import { describe, expect, it } from "vitest";
import { loadExternalAgentTools } from "./external-tools.js";
import { repoRoot } from "../../../../tools_system/_shared/file-utils.js";
import path from "node:path";

const ROOTS = [path.join(repoRoot(), "tools"), path.join(repoRoot(), "tools_system")];

async function chart(params: Record<string, unknown>) {
	const tools = await loadExternalAgentTools(ROOTS, { db: null, tenantId: "t1" } as never);
	const tool = tools.find((t) => t.name === "chart_generate")!;
	const r = (await tool.execute("c1", params)) as { content: Array<{ text: string }>; details: { type: string; chartOption: Record<string, unknown> } };
	return { text: r.content.map((c) => c.text).join(""), option: r.details.chartOption, type: r.details.type };
}

describe("chart_generate 统计图", () => {
	it("bar:生成 ECharts 柱状图配置并输出 echarts 代码块", async () => {
		const { text, option, type } = await chart({ type: "bar", title: "近7天分析量", categories: ["周一", "周二"], series: [{ name: "分析量", data: [3, 5] }] });
		expect(type).toBe("bar");
		expect(option.series).toHaveLength(1);
		expect((option.series as Array<{ name: string; type: string }>)[0].type).toBe("bar");
		expect(text).toContain("```echarts");
		expect(text).toContain("近7天分析量");
	});

	it("line:多系列折线图", async () => {
		const { option } = await chart({ type: "line", categories: ["1月", "2月"], series: [{ name: "成交", data: [2, 4] }, { name: "试驾", data: [3, 5] }] });
		const series = option.series as Array<{ type: string; data: number[] }>;
		expect(series).toHaveLength(2);
		expect(series[0].type).toBe("line");
		expect(series[1].data).toEqual([3, 5]);
	});

	it("pie:饼图按 categories+data 映射名称与值", async () => {
		const { option } = await chart({ type: "pie", categories: ["价格异议", "需求确认"], series: [{ name: "意图", data: [6, 2] }] });
		const data = (option.series as Array<{ data: Array<{ name: string; value: number }> }>)[0].data;
		expect(data).toEqual([{ name: "价格异议", value: 6 }, { name: "需求确认", value: 2 }]);
	});

	it("缺 series 返回错误", async () => {
		const tools = await loadExternalAgentTools(ROOTS, { db: null, tenantId: "t1" } as never);
		const tool = tools.find((t) => t.name === "chart_generate")!;
		const r = (await tool.execute("c2", { type: "bar" })) as { content: Array<{ text: string }> };
		expect(r.content.map((c) => c.text).join("")).toContain("需要 series");
	});
});