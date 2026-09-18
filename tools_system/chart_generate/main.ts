interface ToolContext { db: any; tenantId: string; }

/**
 * 生成 ECharts 配置,供前端 ECharts 组件原样渲染(任意图表类型)。
 * - 推荐:直接传 option(完整 ECharts 配置),模型想画什么图就画什么图(柱状/折线/饼图/漏斗/散点/雷达/桑基等);
 * - 兼容:传 type/title/categories/series 由工具按常见形态组装。
 */
export function execute(_ctx: ToolContext, params: any) {
	const title = String(params?.title ?? "").trim();
	let option: Record<string, unknown>;

	if (params?.option && typeof params.option === "object" && !Array.isArray(params.option)) {
		// 透传模型给出的完整 ECharts 配置:不限制图表类型
		option = params.option as Record<string, unknown>;
		if (title && !option.title) option.title = { text: title };
	} else {
		const type = String(params?.type ?? "bar");
		const categories = Array.isArray(params?.categories) ? params.categories.map((c: unknown) => String(c)) : [];
		const rawSeries = Array.isArray(params?.series) ? params.series : [];
		if (rawSeries.length === 0) {
			return { content: [{ type: "text", text: "需要 series(一个或多个 {name, data}),或直接传 option 提供完整图表配置。" }] };
		}
		option = {
			title: title ? { text: title } : undefined,
			tooltip: { trigger: type === "pie" || type === "funnel" ? "item" : "axis" },
			legend: rawSeries.length > 1 ? {} : undefined,
		};
		if (type === "funnel") {
			const names = categories.length ? categories : rawSeries[0].data.map((_: unknown, i: number) => `阶段${i + 1}`);
			const data = names.map((name: string, i: number) => ({ name, value: Number(rawSeries[0].data[i] ?? 0) }));
			option.tooltip = { trigger: "item", formatter: "{b}: {c} ({d}%)" };
			option.series = [{
				type: "funnel",
				left: "12%",
				top: 30,
				bottom: 20,
				width: "76%",
				minSize: "18%",
				sort: "descending",
				gap: 4,
				label: { show: true, position: "inside", formatter: "{b}: {c}" },
				data,
			}];
		} else if (type === "pie") {
			const names = categories.length ? categories : rawSeries[0].data.map((_: unknown, i: number) => `项${i + 1}`);
			const data = names.map((name: string, i: number) => ({ name, value: Number(rawSeries[0].data[i] ?? 0) }));
			option.series = [{ type: "pie", radius: "60%", data }];
		} else {
			// 直角坐标系类(bar/line/scatter 等):分类轴 + 数值轴 + 系列
			option.xAxis = { type: "category", data: categories };
			option.yAxis = { type: "value" };
			option.series = rawSeries.map((s: any) => ({
				name: String(s.name ?? "系列"),
				type,
				data: (Array.isArray(s.data) ? s.data : []).map((v: unknown) => Number(v ?? 0)),
			}));
		}
	}

	const json = JSON.stringify(option);
	const text = `${title ? `### ${title}\n` : ""}` + "```echarts\n" + json + "\n```";
	const chartType = ((option.series as Array<{ type?: string }> | undefined)?.[0]?.type) ?? "custom";
	return { content: [{ type: "text", text }], details: { type: chartType, chartOption: option } };
}
