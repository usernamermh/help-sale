import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

interface ToolContext { db: any; tenantId: string; }

interface SubTask { id: string; title: string; goal: string; input?: unknown; status: string; createdAt: string; updatedAt: string; }

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// 每次执行时取路径,便于测试用 SUBAGENTS_DIR 重定向
const queueDir = () => process.env.SUBAGENTS_DIR ?? path.join(repoRoot, "data", "subagents");

export function execute(_ctx: ToolContext, params: any) {
	const op = String(params?.op ?? "list");
	if (op === "create") {
		const title = String(params?.title ?? "").trim();
		const goal = String(params?.goal ?? "").trim();
		if (!title || !goal) return { content: [{ type: "text", text: "create 需要 title 与 goal。" }] };
		mkdirSync(queueDir(), { recursive: true });
		const now = new Date().toISOString();
		const id = randomUUID();
		const task: SubTask = { id, title, goal, input: params?.input, status: "queued", createdAt: now, updatedAt: now };
		writeFileSync(path.join(queueDir(), `${id}.json`), JSON.stringify(task, null, 2), "utf8");
		return { content: [{ type: "text", text: `子代理任务已登记 ${id}: ${title}` }], details: { id, path: path.join(queueDir(), `${id}.json`) } };
	}
	if (op === "list") {
		if (!existsSync(queueDir())) return { content: [{ type: "text", text: "(子代理队列为空)" }], details: { tasks: [] } };
		const filter = params?.statusFilter ? String(params.statusFilter) : undefined;
		const tasks: SubTask[] = [];
		for (const file of readdirSync(queueDir()).filter((f) => f.endsWith(".json"))) {
			try { tasks.push(JSON.parse(readFileSync(path.join(queueDir(), file), "utf8")) as SubTask); } catch { /* 跳过损坏 */ }
		}
		const items = tasks.filter((t) => !filter || t.status === filter);
		const text = items.length ? items.map((t) => `[${t.status}] ${t.id.slice(0, 8)} ${t.title}: ${t.goal}`).join("\n") : "(子代理队列为空)";
		return { content: [{ type: "text", text: `子代理队列(${items.length}):\n${text}` }], details: { tasks: items } };
	}
	return { content: [{ type: "text", text: `未知操作 ${op}(支持 create/list)` }] };
}