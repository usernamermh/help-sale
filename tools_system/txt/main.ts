import { existsSync, readFileSync, statSync } from "node:fs";
import { resolveRepoPath } from "../_shared/file-utils.js";

interface ToolContext { db: any; tenantId: string; }

const ALLOWED = /\.(txt|md|csv|json|log|yaml|yml|xml|html)$/i;

export async function execute(_ctx: ToolContext, params: any) {
	const file = resolveRepoPath(String(params?.filePath ?? ""));
	if (!file) return { content: [{ type: "text", text: "路径无效:仅允许仓库内文件,禁止越界读取。" }] };
	if (!ALLOWED.test(file)) return { content: [{ type: "text", text: "不支持的文件类型(仅 txt/md/csv/json/log/yaml/xml/html)。" }] };
	if (!existsSync(file)) return { content: [{ type: "text", text: `文件不存在:${file}` }] };
	const size = statSync(file).size;
	if (size > 5 * 1024 * 1024) return { content: [{ type: "text", text: "文件超过 5MB 限制。" }] };
	const maxChars = Math.min(Number(params?.maxChars ?? 4000) || 4000, 20000);
	const content = readFileSync(file, "utf8");
	return { content: [{ type: "text", text: content.slice(0, maxChars) + (content.length > maxChars ? `\n…(已截断,共 ${content.length} 字符)` : "") }], details: { path: file, size, chars: content.length } };
}