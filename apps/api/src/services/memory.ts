import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../env.js";

/**
 * 记忆模块:系统/用户记忆以 memory.md 落盘,构建 Agent 系统提示词时拼接。
 * 记忆只承载"用户偏好/系统经验",业务数据(客户/会话/订单)一律走数据库。
 */
export const MEMORY_SECTIONS = ["用户记忆", "系统记忆", "工具经验", "规则改进", "模型端点"] as const;
export type MemorySection = (typeof MEMORY_SECTIONS)[number];

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

export function memoryFilePath(): string {
	const raw = config.memoryFile || "apps/api/data/memory.md";
	return path.isAbsolute(raw) ? raw : path.join(repoRoot, raw);
}

export const MEMORY_TEMPLATE = `# 记忆文件(Memory)

> 本文件拼入 Agent 系统提示词,只记录用户偏好与系统运行经验;业务数据请写入数据库。
> 新增记忆请使用 update_memory 工具,保持小节结构。

## 用户记忆

## 系统记忆

## 工具经验

## 规则改进

## 模型端点
`;

export function loadMemoryText(filePath = memoryFilePath()): string {
	if (!existsSync(filePath)) return MEMORY_TEMPLATE;
	try {
		return readFileSync(filePath, "utf8") || MEMORY_TEMPLATE;
	} catch {
		return MEMORY_TEMPLATE;
	}
}

function normalizeSection(section: string): MemorySection | null {
	const hit = MEMORY_SECTIONS.find((s) => section.includes(s));
	return hit ?? null;
}

/** 在指定小节追加一条记忆(幂等:完全相同的行不重复追加);文件不存在则先创建模板。 */
export function appendMemory(filePath: string, section: string, content: string): string {
	const target = normalizeSection(section);
	if (!target) throw new Error(`记忆小节必须为:${MEMORY_SECTIONS.join("/")}`);
	const text = loadMemoryText(filePath);
	const line = `- ${content.replace(/\s+/g, " ").trim()}`;
	if (text.includes(line)) return text; // 去重
	const marker = `## ${target}`;
	const idx = text.indexOf(marker);
	if (idx < 0) return text; // 模板异常,跳过
	const lineEnd = text.indexOf("\n", idx);
	const insertAt = lineEnd < 0 ? text.length : lineEnd + 1;
	const updated = text.slice(0, insertAt) + line + "\n" + text.slice(insertAt);
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, updated, "utf8");
	return updated;
}

/** 初始化:若文件不存在则写入模板。 */
export function ensureMemoryFile(filePath = memoryFilePath()): string {
	if (!existsSync(filePath)) {
		mkdirSync(path.dirname(filePath), { recursive: true });
		writeFileSync(filePath, MEMORY_TEMPLATE, "utf8");
	}
	return loadMemoryText(filePath);
}