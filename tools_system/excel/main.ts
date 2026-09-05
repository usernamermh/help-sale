import path from "node:path";
import { existsSync } from "node:fs";
import { resolveRepoPath } from "../_shared/file-utils.js";

interface ToolContext { db: any; tenantId: string; }

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
	const max = Math.min(Number(params?.maxRows ?? 20) || 20, 200);
	const head = allRows.slice(0, max);
	const textRows = head.map((r) => (Array.isArray(r) ? r.map((v) => String(v ?? "")).join("\t") : String(r)));
	const text = textRows.join("\n") + (allRows.length > max ? `\n…(共 ${allRows.length} 行,仅显示前 ${max} 行)` : "");
	return {
		content: [{ type: "text", text: `Excel(${path.basename(file)}, 表:${sheetName})\n${text.slice(0, 8000)}` }],
		details: { path: file, sheet: sheetName, rowCount: allRows.length, rows: head },
	};
}