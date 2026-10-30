import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolveRepoPath } from "../_shared/file-utils.js";

/**
 * 读取仓库内文本文件:输出**带绝对行号**的内容 + 总行数 + 内容 hash,
 * 让模型可以直接用 file_write(op=patch/replace, expectedHash=…) 精确修改。
 */

interface ToolContext { db: unknown; tenantId: string; }

const ALLOWED = /\.(txt|md|csv|json|log|yaml|yml|xml|html)$/i;
const MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_LINES = 200;
const HARD_MAX_LINES = 1000;

export async function execute(_ctx: ToolContext, params: any) {
	const file = resolveRepoPath(String(params?.filePath ?? ""));
	if (!file) return { content: [{ type: "text", text: "路径无效:仅允许仓库内文件,禁止越界读取。" }] };
	if (!ALLOWED.test(file)) return { content: [{ type: "text", text: "不支持的文件类型(仅 txt/md/csv/json/log/yaml/xml/html;其它类型请用 file_read)。" }] };
	if (!existsSync(file)) return { content: [{ type: "text", text: `文件不存在:${file}` }] };
	const stat = statSync(file);
	if (stat.size > MAX_BYTES) return { content: [{ type: "text", text: "文件超过 5MB 限制。" }] };

	const raw = readFileSync(file);
	if (raw.includes(0)) return { content: [{ type: "text", text: `看起来是二进制文件,不能按文本读取:${file}` }] };
	let text = raw.toString("utf8");
	const bom = text.charCodeAt(0) === 0xfeff;
	if (bom) text = text.slice(1);
	const crlf = (text.match(/\r\n/g) ?? []).length;
	const lf = (text.match(/\n/g) ?? []).length - crlf;
	const eol = crlf > lf ? "CRLF" : "LF";
	const endsWithNewline = text.endsWith("\n");
	const body = endsWithNewline ? text.replace(/\r?\n$/, "") : text;
	const lines = text.length === 0 ? [] : body.split(/\r?\n/);
	const hash = createHash("sha256").update(raw).digest("hex").slice(0, 12);

	const startLine = Math.max(Number(params?.startLine ?? 1) || 1, 1);
	const maxLines = Math.min(Math.max(Number(params?.maxLines ?? DEFAULT_MAX_LINES) || DEFAULT_MAX_LINES, 1), HARD_MAX_LINES);
	const slice = lines.slice(startLine - 1, startLine - 1 + maxLines);
	const width = String(startLine + slice.length - 1).length;
	const numbered = slice.map((line, i) => `${String(startLine + i).padStart(width)}| ${line}`).join("\n");
	const shownTo = startLine - 1 + slice.length;
	const more = shownTo < lines.length ? `\n…(仅显示第 ${startLine}-${shownTo} 行,共 ${lines.length} 行;继续读传 startLine=${shownTo + 1})` : "";
	const header = `文件:${file}\n共 ${lines.length} 行 · hash=${hash} · 换行=${eol}${bom ? " · 含 BOM" : ""}\n`;
	const footer = `\n\n(修改请用 file_write:op=patch 按行号改,或 op=replace 整份替换,并带上 expectedHash=${hash})`;

	return {
		content: [{ type: "text", text: header + numbered + more + footer }],
		details: { path: file, size: stat.size, lines: lines.length, hash, startLine, shownTo, eol: eol === "CRLF" ? "\r\n" : "\n", bom, hasMore: shownTo < lines.length },
	};
}