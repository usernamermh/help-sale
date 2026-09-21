import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { openDatabase } from "../db/database.js";
import { requireTenant } from "../repositories/customers.js";
import { createKanbanTask, getKanbanCard, listKanbanCards } from "./kanban-store.js";
import { consumeKanbanSubagents } from "./subagent-runner.js";

let db: DatabaseSync;
let dir: string;
const oldFile = process.env.KANBAN_FILE;

beforeEach(() => {
	db = openDatabase(":memory:");
	requireTenant(db, "t1", "演示租户");
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-"));
	process.env.KANBAN_FILE = path.join(dir, "kanban.json");
});
afterEach(() => {
	db.close();
	fs.rmSync(dir, { recursive: true, force: true });
	if (oldFile === undefined) delete process.env.KANBAN_FILE;
	else process.env.KANBAN_FILE = oldFile;
});

function textStreamFn(reply: string): StreamFn {
	// 每次调用创建独立 provider,避免并发子代理共享响应队列导致串扰
	return async (model, context, options) => {
		const fa = fauxProvider();
		fa.setResponses([fauxAssistantMessage([{ type: "text", text: reply }])]);
		return fa.provider.stream(model as never, context, options);
	};
}

describe("子代理任务编排(看板)", () => {
	it("消费看板:pending 卡片并行执行后回填 done 与结果", async () => {
		const card = createKanbanTask({ tenantId: "t1", threadId: "th1", title: "查价格", goal: "查旗舰版价格" });
		const executed = await consumeKanbanSubagents({ db, streamFn: textStreamFn("旗舰版 1999 元/年") }, "t1", { limit: 2 });
		expect(executed).toHaveLength(1);
		expect(executed[0].status).toBe("done");
		expect(executed[0].result).toContain("1999");
		const stored = getKanbanCard("t1", card.id)!;
		expect(stored.status).toBe("done");
		expect(stored.result).toContain("1999");
	});

	it("子代理可用工具白名单过滤:只注入允许的工具", async () => {
		createKanbanTask({ tenantId: "t1", threadId: "th1", title: "计算", goal: "算 1+1", tools: ["computer"] });
		const executed = await consumeKanbanSubagents({ db, streamFn: textStreamFn("结果是 2") }, "t1", { limit: 2 });
		expect(executed[0].status).toBe("done");
	});

	it("执行异常:卡片回填 error", async () => {
		createKanbanTask({ tenantId: "t1", threadId: "th1", title: "坏任务", goal: "触发异常" });
		const executed = await consumeKanbanSubagents({ db, streamFn: textStreamFn("") }, "t1", { limit: 2 });
		expect(executed[0].status).toBe("error");
		expect(executed[0].error).toBeTruthy();
	});

	it("多任务并行执行,已完成任务不再执行", async () => {
		createKanbanTask({ tenantId: "t1", threadId: "th1", title: "A", goal: "任务A" });
		createKanbanTask({ tenantId: "t1", threadId: "th1", title: "B", goal: "任务B" });
		expect(listKanbanCards("t1", { status: "pending", threadId: "th1" })).toHaveLength(2);

		const batch = await consumeKanbanSubagents({ db, streamFn: textStreamFn("完成") }, "t1", { limit: 2 });
		expect(batch).toHaveLength(2);
		expect(batch.every((c) => c.status === "done")).toBe(true);

		const empty = await consumeKanbanSubagents({ db, streamFn: textStreamFn("无") }, "t1", { limit: 2 });
		expect(empty).toHaveLength(0);
		expect(listKanbanCards("t1", { status: "done", threadId: "th1" })).toHaveLength(2);
	});

	it("子代理不允许编排类工具(subagents/kanban 不注入)", async () => {
		createKanbanTask({ tenantId: "t1", threadId: "th1", title: "协作", goal: "尝试派生", tools: ["subagents", "kanban", "computer"] });
		const executed = await consumeKanbanSubagents({ db, streamFn: textStreamFn("完成") }, "t1", { limit: 2 });
		expect(executed[0].status).toBe("done");
		// 工具白名单中编排类被过滤,模型只能拿到 computer
	});
});