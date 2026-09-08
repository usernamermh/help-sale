import type { DatabaseSync } from "node:sqlite";
import { readRuntimeLogs } from "./runtime-log.js";
import { toolLabel } from "../pi/capabilities.js";

export type ConsoleLogCategory = "runtime" | "agent" | "notification";

export interface ConsoleLogItem {
	id: string;
	ts: string;
	category: ConsoleLogCategory;
	subCategory: string;
	summary: string;
}

export interface ConsoleLogQuery {
	tenantId: string;
	limit?: number;
	category?: "all" | ConsoleLogCategory;
	q?: string;
}

export function queryConsoleLogs(db: DatabaseSync, dataDir: string, query: ConsoleLogQuery): ConsoleLogItem[] {
	const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
	const q = query.q?.trim();
	const cat = query.category ?? "all";
	const items: ConsoleLogItem[] = [];

	if (cat === "all" || cat === "agent") {
		const conds = ["tenant_id = ?", "event_type IN ('tool_start','tool_end')"];
		const params: Array<string | number> = [query.tenantId];
		if (q) {
			conds.push("(event_type LIKE ? OR tool_name LIKE ? OR payload_json LIKE ?)");
			params.push(`%${q}%`, `%${q}%`, `%${q}%`);
		}
		const rows = db
			.prepare(`SELECT id, event_type, tool_name, payload_json, created_at FROM agent_events WHERE ${conds.join(" AND ")} ORDER BY created_at DESC, seq DESC LIMIT ?`)
			.all(...params, limit) as Array<Record<string, unknown>>;
		for (const r of rows) {
			items.push({
				id: String(r.id),
				ts: String(r.created_at),
				category: "agent",
				subCategory: r.event_type === "tool_start" ? "调用工具" : r.event_type === "tool_end" ? "返回结果" : String(r.event_type),
				summary: `${toolLabel(r.tool_name as string)}: ${summarizePayload(r.payload_json)}`,
			});
		}
	}

	if (cat === "all" || cat === "notification") {
		const conds = ["tenant_id = ?"];
		const params: Array<string | number> = [query.tenantId];
		if (q) {
			conds.push("(title LIKE ? OR channel LIKE ? OR content_json LIKE ? OR status LIKE ?)");
			params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
		}
		const rows = db
			.prepare(`SELECT id, channel, title, status, created_at FROM notification_logs WHERE ${conds.join(" AND ")} ORDER BY created_at DESC LIMIT ?`)
			.all(...params, limit) as Array<Record<string, unknown>>;
		for (const r of rows) {
			items.push({
				id: String(r.id),
				ts: String(r.created_at),
				category: "notification",
				subCategory: String(r.status ?? "sent"),
				summary: `${r.title ?? ""} (${r.channel ?? "webhook"})`,
			});
		}
	}

	if (cat === "all" || cat === "runtime") {
		for (const e of readRuntimeLogs(dataDir, { limit, q })) {
			items.push({
				id: `rt-${e.ts}`,
				ts: e.ts,
				category: "runtime",
				subCategory: e.type,
				summary: e.message,
			});
		}
	}

	return items
		.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
		.slice(0, limit);
}

function summarizePayload(payloadJson: unknown): string {
	if (!payloadJson) return "";
	const text = String(payloadJson);
	try {
		const parsed = JSON.parse(text) as { content?: Array<{ text?: string }>; [key: string]: unknown };
		if (Array.isArray(parsed.content)) {
			const content = parsed.content
				.map((c) => c?.text ?? "")
				.join(" ")
				.trim();
			if (content) return content;
		}
		return text;
	} catch {
		return text;
	}
}