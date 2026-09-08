interface ToolContext { db: any; tenantId: string; }

function toMarkdownTable(rows: unknown[]): string {
	if (!Array.isArray(rows) || rows.length === 0) return "(空数据)";
	const first = rows[0];
	let headers: string[] = [];
	let body: string[][] = [];
	if (Array.isArray(first)) {
		headers = (first as unknown[]).map((_, i) => `列${i + 1}`);
		body = rows as string[][];
	} else if (first && typeof first === "object") {
		headers = Object.keys(first as Record<string, unknown>);
		body = (rows as Array<Record<string, unknown>>).map((r) => headers.map((h) => String(r[h] ?? "")));
	} else {
		headers = ["值"]; body = rows.map((r) => [String(r)]);
	}
	const lines = [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`];
	for (const row of body) lines.push(`| ${[...row, ...Array(Math.max(headers.length - row.length, 0)).fill("")].slice(0, headers.length).join(" | ")} |`);
	return lines.join("\n");
}

export function execute(_ctx: ToolContext, params: any) {
	const parts: string[] = [];
	if (params?.title) parts.push(`### ${params.title}`);
	const chartType = params?.chartType ?? "table";
	const allRows = Array.isArray(params?.rows) ? (params.rows as unknown[]) : [];
	const pageSize = 10;
	const page = Math.max(Number(params?.page ?? 1) || 1, 1);
	const totalPages = Math.max(Math.ceil(allRows.length / pageSize), 1);
	const p = Math.min(page, totalPages);
	const pageRows = allRows.slice((p - 1) * pageSize, p * pageSize);
	const tableText = toMarkdownTable(pageRows);
	const footer = totalPages > 1 ? `\n(第 ${p}/${totalPages} 页 · 共 ${allRows.length} 行;用户要求查看更多时再传 page=${p + 1})` : "";
	if (chartType === "table" || chartType === "both") parts.push(tableText + footer);
	if (chartType === "mermaid" || chartType === "both") {
		if (Array.isArray(params?.graph) && params.graph.length > 0) {
			const edges = params.graph.map((g: any, i: number) => `  n${i}[${String(g.from)}] --> n${i}x[${String(g.to)}]${g.label ? `|${String(g.label)}|` : ""}`).join("\n");
			parts.push("```mermaid\nflowchart LR\n" + edges + "\n```");
		}
		if (Array.isArray(params?.pie) && params.pie.length > 0) {
			const data = params.pie.map((p: any) => `  "${String(p.label)}" : ${Number(p.value ?? 0)}`).join("\n");
			parts.push("```mermaid\npie\n" + data + "\n```");
		}
		if (!Array.isArray(params?.graph) && !Array.isArray(params?.pie)) parts.push("(未提供 graph/pie 数据,仅生成表格)");
	}
	return {
		content: [{ type: "text", text: parts.join("\n") || "(无内容)" }],
		details: { table: tableText, page: p, pageSize, totalRows: allRows.length, totalPages, hasMore: p < totalPages },
	};
}