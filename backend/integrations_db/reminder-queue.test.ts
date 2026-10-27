import { describe, expect, it } from "vitest";
import { createMemoryReminderQueue } from "./reminder-queue.js";

describe("memory reminder queue", () => {
	it("add/due/remove 生命周期", async () => {
		const q = createMemoryReminderQueue();
		await q.add("t_old", Date.now() - 1000);
		await q.add("t_now", Date.now() + 5000);
		await q.add("t_future", Date.now() + 60_000);
		const due = await q.due(Date.now());
		expect(due).toEqual(["t_old"]);

		await q.remove("t_old");
		expect(await q.due(Date.now())).toEqual([]);
		await q.close();
	});

	it("null 到期不入队", async () => {
		const q = createMemoryReminderQueue();
		await q.add("x", null);
		expect(await q.due(Date.now())).toEqual([]);
		await q.close();
	});
});