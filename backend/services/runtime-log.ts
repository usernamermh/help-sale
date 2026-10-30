import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import path from "node:path";

export type RuntimeLogLevel = "debug" | "info" | "error";

/** 级别阈值:debug < info < error,entry.level 低于配置级别时丢弃 */
const LEVEL_RANK: Record<RuntimeLogLevel, number> = { debug: 0, info: 1, error: 2 };

export interface RuntimeLogEntry {
	ts: string;
	level: RuntimeLogLevel;
	type: "request" | "startup" | "error" | "debug" | "tenant_rejected";
	message: string;
	meta?: unknown;
}

export interface RuntimeLogOptions {
	/** 日志文件名,默认 runtime.log */
	fileName?: string;
	/** 最低落盘级别:debug 全部写入;info 写 info/error;error 只写 error */
	level: RuntimeLogLevel;
	/** 轮转上限(字节) */
	maxBytes: number;
}

/** 默认运行日志文件名,位于 logging.dir 下 */
export const DEFAULT_RUNTIME_LOG_FILE = "runtime.log";

export function resolveRuntimeLogPath(dir: string, fileName: string): string {
	return path.join(dir, fileName);
}

/**
 * 追加一条运行日志(NDJSON)。
 * 低于 level 的日志直接丢弃(如配置为 error 时跳过 debug/info);
 * 落盘失败不影响调用方。
 */
export function appendRuntimeLog(dir: string, entry: Omit<RuntimeLogEntry, "ts">, opts: RuntimeLogOptions): void {
	if (LEVEL_RANK[entry.level] < LEVEL_RANK[opts.level]) return;
	try {
		mkdirSync(dir, { recursive: true });
		const file = resolveRuntimeLogPath(dir, opts.fileName ?? DEFAULT_RUNTIME_LOG_FILE);
		const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
		appendFileSync(file, line + "\n", "utf8");
		// 简单滚动:超过上限时保留最近一半
		try {
			const size = Buffer.byteLength(readFileSync(file, "utf8"));
			if (size > opts.maxBytes) {
				const content = readFileSync(file, "utf8");
				const lines = content.split("\n").filter(Boolean);
				writeFileSync(file, lines.slice(Math.floor(lines.length / 2)).join("\n") + "\n", "utf8");
			}
		} catch {}
	} catch {}
}

export function readRuntimeLogs(dir: string, opts: { limit: number; q?: string; fileName?: string }): RuntimeLogEntry[] {
	const file = resolveRuntimeLogPath(dir, opts.fileName ?? DEFAULT_RUNTIME_LOG_FILE);
	if (!existsSync(file)) return [];
	const q = opts.q?.trim().toLowerCase();
	const out: RuntimeLogEntry[] = [];
	const lines = readFileSync(file, "utf8").split("\n");
	for (let i = lines.length - 1; i >= 0 && out.length < opts.limit; i--) {
		const line = lines[i];
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as RuntimeLogEntry;
			const hay = `${entry.message} ${entry.meta ? JSON.stringify(entry.meta) : ""}`.toLowerCase();
			if (q && !hay.includes(q)) continue;
			out.push(entry);
		} catch {}
	}
	return out;
}