import { describe, expect, it } from "vitest";
import { createMemoryReminderQueue } from "./reminder-queue.js";

describe("memory reminder queue", () => {
	it("add/due/remove 生命周期:条目带租户维度", async () => {
		const q = createMemoryReminderQueue();
		await q.add("t1", "t_old", Date.now() - 1000);
		await q.add("t1", "t_now", Date.now() + 5000);
		await q.add("t2", "t_future", Date.now() + 60_000);
		const due = await q.due(Date.now());
		expect(due).toEqual([{ tenantId: "t1", taskId: "t_old" }]);

		// 删别的租户的同名任务不会误删
		await q.remove("t2", "t_old");
		expect(await q.due(Date.now())).toEqual([{ tenantId: "t1", taskId: "t_old" }]);

		await q.remove("t1", "t_old");
		expect(await q.due(Date.now())).toEqual([]);
		await q.close();
	});

	it("null 到期不入队", async () => {
		const q = createMemoryReminderQueue();
		await q.add("t1", "x", null);
		expect(await q.due(Date.now())).toEqual([]);
		await q.close();
	});
});