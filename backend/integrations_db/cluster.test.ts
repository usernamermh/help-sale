import { describe, expect, it } from "vitest";
import { createClusterCoordinator } from "./cluster.js";

describe("集群协调层:Redis 不可用时的降级", () => {
	const offline = createClusterCoordinator({ enabled: false, host: "127.0.0.1", port: 6379, leaderLeaseMs: 30000 });

	it("未启用 Redis 时标记为进程内模式,本实例即唯一实例", () => {
		expect(offline.redisEnabled).toBe(false);
		expect(offline.isLeader("anything")).toBe(true);
		let called: boolean | undefined;
		const stop = offline.watchLeadership("automation", (isLeader) => { called = isLeader; });
		expect(called).toBe(true);
		stop();
	});

	it("未启用 Redis:广播是空操作,不影响进程内唤醒", async () => {
		expect(() => offline.publish("chan", "msg")).not.toThrow();
		const unsubscribe = offline.subscribe("chan", () => { throw new Error("不该被调用"); });
		await expect(offline.close()).resolves.toBeUndefined();
		unsubscribe();
	});

	it("实例标识带主机与进程,便于排查", () => {
		expect(offline.instanceId).toMatch(/-/);
	});
});