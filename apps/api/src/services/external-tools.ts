import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

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
	/** 可选:readme.json 声明的分类(前端能力清单用) */
	category?: string;
	/** 可选:readme.json 声明的中文展示名 */
	label?: string;
	/** 可选:readme.json 声明的参数 JSON Schema(缺省时从 main.ts 的 schema 导出取) */
	parameters?: Record<string, unknown>;
	/** 实现入口:优先 readme.json entry,否则 main.ts */
	entry?: string;
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
			let meta: { name?: string; description?: string; function_list?: string[]; category?: string; label?: string; parameters?: unknown; entry?: string };
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
				category: typeof meta.category === "string" ? meta.category : undefined,
				label: typeof meta.label === "string" ? meta.label : undefined,
				parameters: meta.parameters && typeof meta.parameters === "object" ? (meta.parameters as Record<string, unknown>) : undefined,
				entry: typeof meta.entry === "string" ? meta.entry : undefined,
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


/** 外部工具运行时上下文:由宿主注入,外部 main.ts 自行声明同名接口即可(结构化类型)。 */
export interface ExternalToolContext {
	db: unknown;
	tenantId: string;
}

export interface ExternalToolResult {
	content: Array<{ type: "text"; text: string }>;
	details?: unknown;
}

interface ExternalToolModule {
	execute?: (ctx: ExternalToolContext, params: unknown) => ExternalToolResult | string;
	schema?: Record<string, unknown>;
	default?: { execute?: (ctx: ExternalToolContext, params: unknown) => ExternalToolResult | string; schema?: Record<string, unknown> };
}

/** 外部工具加载结果:与 agent 运行时 AgentTool 兼容。 */
export type ExternalAgentTool = AgentTool<any, any>;

/**
 * 从 roots 目录动态加载具备实现入口(main.ts/main.mts)的外部工具,构建 agent 工具列表。
 * 契约:main.ts 导出 `execute(ctx, params)`(或 default.execute),可选导出 `schema` 作为参数 JSON Schema;
 * readme.json 的 parameters/entry 优先于代码内声明。无实现、损坏或加载失败的目录跳过。
 */
export async function loadExternalAgentTools(
	roots: string[],
	ctx: ExternalToolContext,
): Promise<ExternalAgentTool[]> {
	const out: ExternalAgentTool[] = [];
	for (const root of roots) {
		for (const tool of scanExternalTools([root])) {
			if (tool.functions.length === 0) continue; // 纯描述性目录(无实现)不注册为可调用工具
			const entry = tool.entry ?? "main.ts";
			const entryPath = path.join(root, tool.dir, entry);
			if (!existsSync(entryPath)) continue;
		let mod: ExternalToolModule;
		try {
			mod = (await import(pathToFileURL(entryPath).href)) as ExternalToolModule;
		} catch (error) {
			console.warn(`[external-tools] 加载 ${tool.name} 失败:`, error instanceof Error ? error.message : String(error));
			continue;
		}
		const execute = mod.execute ?? mod.default?.execute;
		if (typeof execute !== "function") continue;
		const schema = tool.parameters ?? mod.schema ?? mod.default?.schema ?? {};
		out.push({
			name: tool.name,
			label: tool.label ?? tool.name,
			description: tool.description,
			parameters: schema as never,
			async execute(_toolCallId, params: any): Promise<AgentToolResult<any>> {
				const raw = await execute(ctx, params);
				if (typeof raw === "string") return { content: [{ type: "text" as const, text: raw }], details: null };
				return { content: raw.content as never, details: raw.details ?? null };
			},
		});
	}
	}
	return out;
}

/** 仓库根下 tools / tools_system 的绝对路径列表。 */
export function externalToolPaths(): string[] {
	const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
	return TOOL_ROOTS.map((r) => path.join(repoRoot, r));
}

/** 加载外部工具并按名称取一个;缺失时抛错(目录内应有对应实现)。 */
export async function externalToolByName(roots: string[], ctx: ExternalToolContext, name: string): Promise<ExternalAgentTool> {
	const tools = await loadExternalAgentTools(roots, ctx);
	const tool = tools.find((t) => t.name === name);
	if (!tool) throw new Error(`外部工具 ${name} 未加载(tools 目录缺少实现?)`);
	return tool;
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