import { describe, expect, it } from "vitest";
import { createTenantQuota } from "./tenant-quota.js";

const base = {
	enabled: true,
	requestPerMinute: 60,
	requestBurst: 3,
	agentConcurrency: 2,
	retryAfterSeconds: 5,
};

describe("每租户额度:进程内实现", () => {
	it("请求令牌桶:突发容量用尽即拒,时间流逝后补充", async () => {
		let stamp = 1_000;
		const quota = createTenantQuota({ ...base, now: () => stamp });
		expect(quota.backend).toBe("memory");

		expect((await quota.tryAcquireRequest("t1")).allowed).toBe(true);
		expect((await quota.tryAcquireRequest("t1")).allowed).toBe(true);
		expect((await quota.tryAcquireRequest("t1")).allowed).toBe(true);
		const denied = await quota.tryAcquireRequest("t1");
		expect(denied.allowed).toBe(false);
		expect(denied.retryAfterMs).toBeGreaterThan(0);

		// 另一个租户完全不受影响 —— 这正是"单租户问题不外溢"的核心
		expect((await quota.tryAcquireRequest("t2")).allowed).toBe(true);

		// 1 秒后按 60/分钟 的速率补回 1 个令牌
		stamp += 1_000;
		expect((await quota.tryAcquireRequest("t1")).allowed).toBe(true);
		await quota.close();
	});

	it("agent 并发:超过上限拒绝,释放后可再进", async () => {
		const quota = createTenantQuota(base);
		expect((await quota.tryAcquireAgentRun("t1")).allowed).toBe(true);
		expect((await quota.tryAcquireAgentRun("t1")).allowed).toBe(true);
		expect((await quota.tryAcquireAgentRun("t1")).allowed).toBe(false);
		// 互不影响
		expect((await quota.tryAcquireAgentRun("t2")).allowed).toBe(true);
		expect((await quota.inspect("t1")).agentRuns).toBe(2);

		await quota.releaseAgentRun("t1");
		expect((await quota.inspect("t1")).agentRuns).toBe(1);
		expect((await quota.tryAcquireAgentRun("t1")).allowed).toBe(true);
		await quota.releaseAgentRun("t1");
		await quota.releaseAgentRun("t1");
		expect((await quota.inspect("t1")).agentRuns).toBe(0);
		await quota.close();
	});

	it("关闭时全部放行,不产生额外状态", async () => {
		const quota = createTenantQuota({ ...base, enabled: false });
		expect(quota.backend).toBe("disabled");
		for (let i = 0; i < 10; i++) expect((await quota.tryAcquireRequest("t1")).allowed).toBe(true);
		expect((await quota.tryAcquireAgentRun("t1")).allowed).toBe(true);
		await quota.close();
	});

	it("Redis 未启用时使用进程内后端(单实例也能按租户隔离额度)", async () => {
		const quota = createTenantQuota({ ...base, redis: { enabled: false, host: "127.0.0.1", port: 6379 } });
		expect(quota.backend).toBe("memory");
		await quota.close();
	});
});