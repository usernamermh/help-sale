import path from "node:path";
import { existsSync } from "node:fs";
import AdmZip from "adm-zip";
import { resolveRepoPath } from "../_shared/file-utils.js";

interface ToolContext { db: any; tenantId: string; }

const decodeXml = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/\u200b/g, "");

export async function execute(_ctx: ToolContext, params: any) {
	const file = resolveRepoPath(String(params?.filePath ?? ""));
	if (!file) return { content: [{ type: "text", text: "路径无效:仅允许仓库内文件,禁止越界读取。" }] };
	if (!/\.pptx$/i.test(file)) return { content: [{ type: "text", text: "仅支持 .pptx 文件。" }] };
	if (!existsSync(file)) return { content: [{ type: "text", text: `文件不存在:${file}` }] };
	let zip: any;
	try {
		zip = new AdmZip(file);
	} catch (error) {
		return { content: [{ type: "text", text: `PPT 解压失败:${error instanceof Error ? error.message : String(error)}` }] };
	}
	const entries = zip.getEntries()
		.filter((e: any) => /^ppt\/slides\/slide\d+\.xml$/i.test(e.entryName))
		.sort((a: any, b: any) => Number(/slide(\d+)\.xml/i.exec(a.entryName)?.[1] ?? 0) - Number(/slide(\d+)\.xml/i.exec(b.entryName)?.[1] ?? 0));
	if (!entries.length) return { content: [{ type: "text", text: "未找到幻灯片内容。" }] };
	const max = Math.min(Number(params?.maxSlides ?? 20) || 20, 100);
	const pages: string[] = [];
	for (let i = 0; i < Math.min(entries.length, max); i++) {
		const xml = entries[i].getData().toString("utf8");
		const text = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXml(m[1])).join("").trim();
		pages.push(`— 第 ${i + 1} 页 —\n${text || "(无文字)"}`);
	}
	return {
		content: [{ type: "text", text: `PPT(${path.basename(file)}, 共 ${entries.length} 页)\n${pages.join("\n\n").slice(0, 9000)}` }],
		details: { path: file, slideCount: entries.length, pages },
	};
}