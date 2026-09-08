import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface RuntimeLogEntry {
	ts: string;
	level: "info" | "error";
	type: "request" | "startup" | "error";
	message: string;
	meta?: unknown;
}

const MAX_BYTES = 8 * 1024 * 1024;

export function appendRuntimeLog(dataDir: string, entry: Omit<RuntimeLogEntry, "ts">): void {
	try {
		const file = path.join(dataDir, "runtime.log");
		const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
		appendFileSync(file, line + "\n", "utf8");
		// 简单滚动:超过上限时保留最近一半
		try {
			const size = Buffer.byteLength(readFileSync(file, "utf8"));
			if (size > MAX_BYTES) {
				const content = readFileSync(file, "utf8");
				const lines = content.split("\n").filter(Boolean);
				appendFileSync(file, "", "utf8");
				writeFileSync(file, lines.slice(Math.floor(lines.length / 2)).join("\n") + "\n", "utf8");
			}
		} catch {}
	} catch {}
}

export function readRuntimeLogs(dataDir: string, opts: { limit: number; q?: string }): RuntimeLogEntry[] {
	const file = path.join(dataDir, "runtime.log");
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