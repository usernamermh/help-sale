import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * 外部工具目录约定:
 * - 在 tools / tools_system 下,每个工具的入口子目录内放 readme.json(不再支持 readme.md)。
 * - readme.json 格式:
 *   { "name": "todo_list", "description": "创建、细化、标记完成 todo list", "function_list": ["main.createTodoList", ...] }
 * - function_list 缺省时,从同目录 main.ts / main.py 提取 export function / def 函数名。
 */
export interface ExternalToolInfo {
	root: string;
	dir: string;
	name: string;
	description: string;
	functions: string[];
}

export const TOOL_ROOTS = ["tools", "tools_system"];

/** 遍历若干根目录,收集含 readme.json 的一级子目录为外部工具(按名称排序,损坏 JSON 跳过)。 */
export function scanExternalTools(roots: string[]): ExternalToolInfo[] {
	const out: ExternalToolInfo[] = [];
	for (const root of roots) {
		let entries: Array<{ name: string; isDirectory: boolean }> = [];
		try {
			entries = readdirSync(root, { withFileTypes: true })
				.filter((e) => e.isDirectory())
				.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
		} catch {
			continue;
		}
		for (const entry of entries) {
			const dirPath = path.join(root, entry.name);
			const readmePath = path.join(dirPath, "readme.json");
			if (!existsSync(readmePath)) continue;
			let meta: { name?: string; description?: string; function_list?: string[] };
			try {
				meta = JSON.parse(readFileSync(readmePath, "utf8")) as typeof meta;
			} catch {
				continue; // 损坏的 readme.json 跳过,不影响其他工具
			}
			if (!meta || typeof meta !== "object") continue;
			out.push({
				root: path.basename(path.resolve(root)),
				dir: entry.name,
				name: typeof meta.name === "string" && meta.name ? meta.name : entry.name,
				description: String(meta.description ?? "").replace(/\r\n/g, "\n").trim(),
				functions:
					Array.isArray(meta.function_list) && meta.function_list.length > 0
						? meta.function_list.map(String)
						: extractMainFunctions(dirPath),
			});
		}
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 从 main.ts / main.py 提取导出函数(形如 main.createTodoList),供 function_list 缺省时使用。 */
export function extractMainFunctions(dirPath: string): string[] {
	const funcs: string[] = [];
	for (const file of ["main.ts", "main.mts", "main.py"]) {
		const filePath = path.join(dirPath, file);
		if (!existsSync(filePath)) continue;
		let src: string;
		try {
			src = readFileSync(filePath, "utf8");
		} catch {
			continue;
		}
		const pattern = file.endsWith(".py") ? /^\s*def\s+([\w]+)\s*\(/gm : /(?:export\s+)?(?:async\s+)?function\s+([\w]+)\s*\(/g;
		for (const m of src.matchAll(pattern)) {
			funcs.push(`main.${m[1]}`);
		}
		break; // 只取第一个存在的 main 实现
	}
	return [...new Set(funcs)];
}

/** 生成追加到 system prompt 的外部工具说明块;无工具时返回空串。 */
export function buildExternalToolsText(tools: ExternalToolInfo[]): string {
	if (tools.length === 0) return "";
	const lines: string[] = [
		"【外部工具】以下是通过 tools / tools_system 目录挂载的本地辅助工具(可用于辅助分析,如需调用对应功能请结合其实现环境使用):",
	];
	for (const t of tools) {
		lines.push(`- ${t.name}(${t.root}/${t.dir}): ${t.description}`);
		if (t.functions.length > 0) lines.push(`  函数: ${t.functions.join(", ")}`);
	}
	return lines.join("\n");
}