import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

export type SubTaskStatus = "queued" | "running" | "done" | "error";

export interface SubTask {
	id: string;
	tenantId: string;
	title: string;
	goal: string;
	input?: unknown;
	tools?: string[]; // 允许的工具白名单,缺省使用默认只读工具
	status: SubTaskStatus;
	result?: string;
	error?: string;
	createdAt: string;
	updatedAt: string;
}

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** 子代理队列目录:测试/部署可用 SUBAGENTS_DIR 重定向。 */
export function subagentQueueDir(): string {
	return process.env.SUBAGENTS_DIR ?? path.join(repoRoot, "data", "subagents");
}

function taskFile(id: string): string {
	return path.join(subagentQueueDir(), `${id}.json`);
}

export function createSubTask(input: { tenantId: string; title: string; goal: string; input?: unknown; tools?: string[] }): SubTask {
	mkdirSync(subagentQueueDir(), { recursive: true });
	const now = new Date().toISOString();
	const task: SubTask = { id: randomUUID(), tenantId: input.tenantId, title: input.title, goal: input.goal, input: input.input, tools: input.tools, status: "queued", createdAt: now, updatedAt: now };
	writeFileSync(taskFile(task.id), JSON.stringify(task, null, 2), "utf8");
	return task;
}

export function getSubTask(id: string): SubTask | undefined {
	if (!existsSync(taskFile(id))) return undefined;
	try {
		return JSON.parse(readFileSync(taskFile(id), "utf8")) as SubTask;
	} catch {
		return undefined;
	}
}

export function listSubTasks(statusFilter?: SubTaskStatus): SubTask[] {
	if (!existsSync(subagentQueueDir())) return [];
	const tasks: SubTask[] = [];
	for (const file of readdirSync(subagentQueueDir()).filter((f) => f.endsWith(".json"))) {
		try {
			const t = JSON.parse(readFileSync(path.join(subagentQueueDir(), file), "utf8")) as SubTask;
			if (t && t.id) tasks.push(t);
		} catch {
			/* 跳过损坏 */
		}
	}
	return tasks.filter((t) => !statusFilter || t.status === statusFilter).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function updateSubTask(id: string, patch: Partial<SubTask>): SubTask | undefined {
	const task = getSubTask(id);
	if (!task) return undefined;
	const next: SubTask = { ...task, ...patch, id, createdAt: task.createdAt, updatedAt: new Date().toISOString() };
	writeFileSync(taskFile(id), JSON.stringify(next, null, 2), "utf8");
	return next;
}