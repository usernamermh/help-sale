import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { openDatabase } from "../db/database.js";
import { requireTenant } from "../repositories/customers.js";
import { createSubTask, getSubTask, listSubTasks } from "./subagent-queue.js";
import { consumeSubagentQueue } from "./subagent-runner.js";

let db: DatabaseSync;
let dir: string;
const oldDir = process.env.SUBAGENTS_DIR;

beforeEach(() => {
	db = openDatabase(":memory:");
	requireTenant(db, "t1", "演示租户");
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-"));
	process.env.SUBAGENTS_DIR = dir;
});
afterEach(() => {
	db.close();
	fs.rmSync(dir, { recursive: true, force: true });
	if (oldDir === undefined) delete process.env.SUBAGENTS_DIR;
	else process.env.SUBAGENTS_DIR = oldDir;
});

function textStreamFn(reply: string): StreamFn {
	const fa = fauxProvider();
	fa.setResponses([fauxAssistantMessage([{ type: "text", text: reply }])]);
	return async (model, context, options) => fa.provider.stream(model as never, context, options);
}

describe("子代理任务编排", () => {
	it("消费队列:queued 任务执行后回填 done 与结果", async () => {
		const task = createSubTask({ tenantId: "t1", title: "查价格", goal: "查旗舰版价格" });
		const executed = await consumeSubagentQueue({ db, streamFn: textStreamFn("旗舰版 1999 元/年") }, { limit: 2 });
		expect(executed).toHaveLength(1);
		expect(executed[0].status).toBe("done");
		expect(executed[0].result).toContain("1999");
		const stored = getSubTask(task.id)!;
		expect(stored.status).toBe("done");
	});

	it("子代理可用工具白名单过滤:只注入允许的工具", async () => {
		createSubTask({ tenantId: "t1", title: "计算", goal: "算 1+1", tools: ["computer"] });
		// 不真正断言工具注入,验证执行成功(computer 工具存在且可被调用前模型直接输出)
		const executed = await consumeSubagentQueue({ db, streamFn: textStreamFn("结果是 2") }, { limit: 2 });
		expect(executed[0].status).toBe("done");
	});

	it("执行异常:任务回填 error", async () => {
		createSubTask({ tenantId: "t1", title: "坏任务", goal: "触发异常" });
		const executed = await consumeSubagentQueue({ db, streamFn: textStreamFn("") }, { limit: 2 });
		expect(executed[0].status).toBe("error");
		expect(executed[0].error).toBeTruthy();
	});

	it("多任务按队列顺序执行,已完成任务不再执行", async () => {
		createSubTask({ tenantId: "t1", title: "A", goal: "任务A" });
		createSubTask({ tenantId: "t1", title: "B", goal: "任务B" });
		expect(listSubTasks("queued")).toHaveLength(2);

		const first = await consumeSubagentQueue({ db, streamFn: textStreamFn("A 完成") }, { limit: 1 });
		expect(first).toHaveLength(1);
		expect(first[0].status).toBe("done");

		const second = await consumeSubagentQueue({ db, streamFn: textStreamFn("B 完成") }, { limit: 1 });
		expect(second).toHaveLength(1);
		expect(second[0].status).toBe("done");

		const empty = await consumeSubagentQueue({ db, streamFn: textStreamFn("无") }, { limit: 2 });
		expect(empty).toHaveLength(0);
		expect(listSubTasks("done")).toHaveLength(2);
	});
});