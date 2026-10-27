import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

interface ToolContext { db: any; tenantId: string; }

const TEXT_EXT = /\.(txt|md|csv|json|yaml|yml|log|xml|html|js|ts|py|mjs)$/i;
const XLSX_EXT = /\.(xlsx|xls)$/i;
const PPTX_EXT = /\.pptx$/i;
const DOCX_EXT = /\.docx$/i;
const PDF_EXT = /\.pdf$/i;
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_CHARS = 30000;

const decodeXml = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/\u200b/g, "");

/** 解析 PDF 字符串字面量:(转义文本) 或 <hex>。 */
function decodePdfString(raw: string): string {
	let s = raw.trim();
	if (s.startsWith("(") && s.endsWith(")")) {
		s = s.slice(1, -1);
		return s
			.replace(/\\([()\\])/g, "$1")
			.replace(/\\n/g, "\n")
			.replace(/\\r/g, "\r")
			.replace(/\\t/g, "\t")
			.replace(/\\(\d{1,3})/g, (_m, n: string) => String.fromCharCode(parseInt(n, 8)));
	}
	if (s.startsWith("<") && s.endsWith(">")) {
		return Buffer.from(s.slice(1, -1).replace(/\s/g, ""), "hex").toString("utf8");
	}
	return s;
}

/** 轻量 PDF 文本提取:按对象字典 /Length 精确截取 stream 内容(支持 FlateDecode),提取 BT..ET 内的 (…)Tj/TJ 文本。 */
function extractPdfText(buf: Buffer): string {
	const chunks: string[] = [];
	const latin = buf.toString("latin1");
	const objRe = /(\d+ \d+ obj)\s*<<([\s\S]*?)>>\s*stream\r?\n/g;
	for (const m of latin.matchAll(objRe)) {
		const dict = m[2];
		const length = Number(/\/Length\s+(\d+)/.exec(dict)?.[1]);
		if (!Number.isFinite(length) || length <= 0) continue;
		const start = m.index + m[0].length;
		const raw = latin.slice(start, start + length);
		let data: Buffer;
		if (/\/Filter\s*\/FlateDecode/.test(dict)) {
			try {
				data = zlib.inflateSync(Buffer.from(raw, "latin1"));
			} catch {
				continue;
			}
		} else {
			data = Buffer.from(raw, "latin1");
		}
		const s = data.toString("utf8");
		const parts: string[] = [];
		for (const bt of s.matchAll(/BT[\s\S]*?ET/g)) {
			const strs: string[] = [];
			for (const sm of bt[0].matchAll(/\(((?:[^()\\]|\\.)*)\)|(<[0-9A-Fa-f\s]+>)/g)) {
				strs.push(decodePdfString(sm[0]));
			}
			if (strs.length) parts.push(strs.join(" "));
		}
		if (parts.length) chunks.push(parts.join("\n"));
	}
	return chunks.join("\n\n");
}

/** 从 zip 容器(pptx/docx)中按正则提取 XML 文本节点。 */
async function extractZipText(file: string, entryRe: RegExp, textTagRe: RegExp, sortKey?: (name: string) => number): Promise<string> {
	let AdmZip: any;
	try {
		AdmZip = (await import("adm-zip")).default;
	} catch (error) {
		return `adm-zip 库不可用:${error instanceof Error ? error.message : String(error)}`;
	}
	let zip: any;
	try {
		zip = new AdmZip(file);
	} catch (error) {
		return `解压失败:${error instanceof Error ? error.message : String(error)}`;
	}
	let entries = zip.getEntries().filter((e: any) => entryRe.test(e.entryName));
	if (sortKey) entries = entries.sort((a: any, b: any) => sortKey(a.entryName) - sortKey(b.entryName));
	if (!entries.length) return "(未找到文档内容)";
	const parts: string[] = [];
	for (const e of entries) {
		const xml = e.getData().toString("utf8");
		const text = [...xml.matchAll(textTagRe)].map((m) => decodeXml(m[1])).join("").trim();
		if (text) parts.push(text);
	}
	return parts.join("\n\n") || "(未找到文档内容)";
}

export async function execute(_ctx: ToolContext, params: any) {
	const raw = String(params?.filePath ?? "").trim();
	if (!raw) return { content: [{ type: "text", text: "需要 filePath。" }] };
	const file = path.resolve(raw);
	if (!existsSync(file)) return { content: [{ type: "text", text: `文件不存在:${file}` }] };
	const stat = statSync(file);
	if (!stat.isFile()) return { content: [{ type: "text", text: "路径不是文件。" }] };
	if (stat.size > MAX_BYTES) return { content: [{ type: "text", text: `文件超过 ${MAX_BYTES / 1024 / 1024}MB 限制。` }] };

	const ext = path.extname(file);
	let text = "";
	let format = "text";
	if (TEXT_EXT.test(ext)) {
		text = readFileSync(file, "utf8");
	} else if (XLSX_EXT.test(ext)) {
		format = "excel";
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
		const sheetName = wb.SheetNames?.[0] ?? "";
		const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: "" }) as unknown[][];
		text = `Excel(${path.basename(file)}, 表:${sheetName})\n` + rows.map((r) => (Array.isArray(r) ? r.map((v) => String(v ?? "")).join("\t") : String(r))).join("\n");
	} else if (PPTX_EXT.test(ext)) {
		format = "pptx";
		text = await extractZipText(file, /^ppt\/slides\/slide\d+\.xml$/i, /<a:t>([\s\S]*?)<\/a:t>/g, (n) => Number(/slide(\d+)\.xml/i.exec(n)?.[1] ?? 0));
	} else if (DOCX_EXT.test(ext)) {
		format = "docx";
		text = await extractZipText(file, /^word\/document\.xml$/i, /<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>/g);
	} else if (PDF_EXT.test(ext)) {
		format = "pdf";
		text = extractPdfText(readFileSync(file));
	} else {
		return { content: [{ type: "text", text: `不支持的文件类型:${ext}(支持 txt/md/csv/json/yaml/log/xml/html/xlsx/pdf/pptx/docx 等)。` }] };
	}
	// 分页:按文本行切页(每页 50 行),支持模型传 page 翻页
	const PAGE_SIZE = 50;
	const lines = text.split(/\r?\n/);
	const totalPages = Math.max(Math.ceil(lines.length / PAGE_SIZE), 1);
	const page = Math.max(Number(params?.page ?? 1) || 1, 1);
	const p = Math.min(page, totalPages);
	const pageLines = lines.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE);
	const sliced = pageLines.join("\n").slice(0, MAX_CHARS);
	const footer = totalPages > 1 ? `\n(第 ${p}/${totalPages} 页 · 共 ${lines.length} 行;用户要求查看更多时再传 page=${p + 1})` : "";
	return {
		content: [{ type: "text", text: sliced + footer + (lines.join("\n").length > MAX_CHARS ? `\n…(已截断)` : "") }],
		details: { path: file, format, size: stat.size, chars: text.length, page: p, pageSize: PAGE_SIZE, totalLines: lines.length, totalPages, hasMore: p < totalPages },
	};
}