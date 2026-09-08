import path from "node:path";
import { existsSync } from "node:fs";
import { resolveRepoPath } from "../_shared/file-utils.js";

interface ToolContext { db: any; tenantId: string; }

/** 二维数组转 Markdown 表格(首行视为表头),供表格保真原样展示。 */
function toMarkdownTable(rows: unknown[][]): string {
	if (!rows.length) return "";
	const cells = (r: unknown[]) => r.map((v) => String(v ?? "").replace(/\|/g, "\\|")).join(" | ");
	const lines = [`| ${cells(rows[0])} |`];
	if (rows.length > 1) lines.push(`| ${rows[0].map(() => "---").join(" | ")} |`);
	for (let i = 1; i < rows.length; i++) lines.push(`| ${cells(rows[i])} |`);
	return lines.join("\n");
}

export async function execute(_ctx: ToolContext, params: any) {
	const file = resolveRepoPath(String(params?.filePath ?? ""));
	if (!file) return { content: [{ type: "text", text: "路径无效:仅允许仓库内文件,禁止越界读取。" }] };
	if (!/\.(xlsx|xls|csv)$/i.test(file)) return { content: [{ type: "text", text: "仅支持 .xlsx/.xls/.csv 文件。" }] };
	if (!existsSync(file)) return { content: [{ type: "text", text: `文件不存在:${file}` }] };
	let XLSX: any;
	try {
		XLSX = (await import("xlsx")) as any;
	} catch (error) {
		return { content: [{ type: "text", text: `xlsx 库不可用:${error instanceof Error ? error.message : String(error)}` }] };
	}
	let wb: any;
	try {
		wb = XLSX.readFile(file, { cellDates: false });
	} catch (error) {
		return { content: [{ type: "text", text: `Excel 解析失败:${error instanceof Error ? error.message : String(error)}` }] };
	}
	if (!wb.SheetNames.length) return { content: [{ type: "text", text: "工作簿没有工作表。" }] };
	const want = params?.sheet != null ? String(params.sheet) : "";
	let sheetName = wb.SheetNames[0];
	if (want !== "") sheetName = wb.SheetNames.find((n: string) => n === want) ?? wb.SheetNames[Number(want)] ?? wb.SheetNames[0];
	const ws = wb.Sheets[sheetName];
	const allRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" }) as unknown[][];
	const pageSize = 10;
	const page = Math.max(Number(params?.page ?? 1) || 1, 1);
	const totalPages = Math.max(Math.ceil(allRows.length / pageSize), 1);
	const p = Math.min(page, totalPages);
	const head = allRows.slice((p - 1) * pageSize, p * pageSize);
	const textRows = head.map((r) => (Array.isArray(r) ? r.map((v) => String(v ?? "")).join("\t") : String(r)));
	const footer = totalPages > 1 ? `\n(第 ${p}/${totalPages} 页 · 共 ${allRows.length} 行;用户要求查看更多时再传 page=${p + 1})` : "";
	const text = textRows.join("\n") + footer;
	return {
		content: [{ type: "text", text: `Excel(${path.basename(file)}, 表:${sheetName},第 ${p}/${totalPages} 页)\n${text.slice(0, 8000)}` }],
		details: { path: file, sheet: sheetName, page: p, pageSize, totalRows: allRows.length, totalPages, hasMore: p < totalPages, rows: head, rawTable: toMarkdownTable(head) },
	};
}