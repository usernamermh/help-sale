interface ToolContext { db: any; tenantId: string; }

const CHART_TYPES = ["bar", "line", "pie"];

/** 生成 ECharts 配置:统计图(柱状/折线/饼图),供前端 echarts 渲染(交互式 tooltip/缩放/多系列)。 */
export function execute(_ctx: ToolContext, params: any) {
	const type = CHART_TYPES.includes(params?.type) ? params.type : "bar";
	const title = String(params?.title ?? "").trim();
	const categories = Array.isArray(params?.categories) ? params.categories.map((c: unknown) => String(c)) : [];
	const rawSeries = Array.isArray(params?.series) ? params.series : [];
	if (rawSeries.length === 0) return { content: [{ type: "text", text: "需要 series(一个或多个 {name, data})。" }] };

	const option: Record<string, unknown> = {
		title: title ? { text: title } : undefined,
		tooltip: { trigger: type === "pie" ? "item" : "axis" },
		legend: rawSeries.length > 1 ? {} : undefined,
	};

	if (type === "pie") {
		const names = categories.length ? categories : rawSeries[0].data.map((_: unknown, i: number) => `项${i + 1}`);
		const data = names.map((name: string, i: number) => ({ name, value: Number(rawSeries[0].data[i] ?? 0) }));
		option.series = [{ type: "pie", radius: "60%", data }];
	} else {
		option.xAxis = { type: "category", data: categories };
		option.yAxis = { type: "value" };
		option.series = rawSeries.map((s: any) => ({ name: String(s.name ?? "系列"), type, data: (Array.isArray(s.data) ? s.data : []).map((v: unknown) => Number(v ?? 0)) }));
	}

	const json = JSON.stringify(option);
	const text = `${title ? `### ${title}\n` : ""}\`\`\`echarts\n${json}\n\`\`\``;
	return { content: [{ type: "text", text }], details: { type, chartOption: option } };
}