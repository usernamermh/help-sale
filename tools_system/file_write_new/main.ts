import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

interface ToolContext { db: any; tenantId: string; }

const MAX_CONTENT_BYTES = 1024 * 1024;

export async function execute(_ctx: ToolContext, params: any) {
	const filePath = String(params?.filePath ?? "").trim();
	const content = String(params?.content ?? "");
	if (!filePath || !content) return { content: [{ type: "text", text: "需要 filePath 与 content。" }] };
	if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) {
		return { content: [{ type: "text", text: `内容超过 ${MAX_CONTENT_BYTES / 1024 / 1024}MB 限制,拒绝写入。` }] };
	}
	const target = path.resolve(filePath);
	try {
		mkdirSync(path.dirname(target), { recursive: true });
		// flag "wx" 只允许创建新文件:文件已存在时抛 EEXIST,绝不覆盖/编辑现有文件
		writeFileSync(target, content, { encoding: "utf8", flag: "wx" });
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EEXIST") return { content: [{ type: "text", text: `文件已存在,拒绝覆盖(只允许创建新文件):${target}` }] };
		return { content: [{ type: "text", text: `写入失败:${error instanceof Error ? error.message : String(error)}` }] };
	}
	return {
		content: [{ type: "text", text: `已写入新文件:${target}` }],
		details: { path: target, bytes: Buffer.byteLength(content, "utf8"), created: true },
	};
}