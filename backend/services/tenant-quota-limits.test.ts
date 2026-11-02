import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createQuotaLimitResolver } from "./tenant-quota-limits.js";
import { createTenantQuota } from "./tenant-quota.js";
import { writeTenantSecret } from "../integrations_pi/tables/agents/tenant-secrets.js";

/** 门店级额度:平台写 quota.* 覆盖全局,缺项回退,配完很快生效。 */

function memoryDb(): DatabaseSync {
	const db = new DatabaseSync(":memory:");
	db.exec(
		`CREATE TABLE tenant_secrets (
			tenant_id TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL,
			updated_at TEXT NOT NULL DEFAULT '', PRIMARY KEY (tenant_id, name))`,
	);
	return db;
}

describe("门店级额度解析", () => {
	it("没配就回退全局(返回 undefined)", () => {
		const db = memoryDb();
		const resolve = createQuotaLimitResolver(db, 0);
		expect(resolve("t1")).toBeUndefined();
		db.close();
	});

	it("配了就只覆盖配的那几项", () => {
		const db = memoryDb();
		writeTenantSecret(db, "t1", "quota.requestPerMinute", "120");
		const resolve = createQuotaLimitResolver(db, 0);
		expect(resolve("t1")).toEqual({ requestPerMinute: 120, requestBurst: undefined, agentConcurrency: undefined });
		expect(resolve("t2")).toBeUndefined();
		db.close();
	});

	it("非法值当没配(不把限额配成 0 或负数)", () => {
		const db = memoryDb();
		writeTenantSecret(db, "t1", "quota.requestPerMinute", "abc");
		writeTenantSecret(db, "t1", "quota.agentConcurrency", "-3");
		const resolve = createQuotaLimitResolver(db, 0);
		expect(resolve("t1")).toBeUndefined();
		db.close();
	});

	it("有缓存:配完最多几秒生效,clear 后立刻生效", () => {
		const db = memoryDb();
		const resolve = createQuotaLimitResolver(db, 60_000);
		expect(resolve("t1")).toBeUndefined();
		writeTenantSecret(db, "t1", "quota.requestPerMinute", "30");
		expect(resolve("t1")).toBeUndefined(); // 缓存内还是老值
		resolve.clear();
		expect(resolve("t1")?.requestPerMinute).toBe(30);
		db.close();
	});
});

describe("限流器真的按门店额度走", () => {
	it("被覆盖的门店按自己的额度拦,其他门店不受影响", async () => {
		const db = memoryDb();
		writeTenantSecret(db, "small", "quota.requestPerMinute", "1");
		writeTenantSecret(db, "small", "quota.requestBurst", "1");
		const quota = createTenantQuota({
			enabled: true,
			requestPerMinute: 600,
			requestBurst: 120,
			agentConcurrency: 3,
			retryAfterSeconds: 1,
			redis: { enabled: false, host: "", port: 0, password: "" },
			resolveLimits: createQuotaLimitResolver(db, 0),
		});
		// 小额度门店:桶容量 1,第二下就被拦
		expect((await quota.tryAcquireRequest("small")).allowed).toBe(true);
		const second = await quota.tryAcquireRequest("small");
		expect(second.allowed).toBe(false);
		expect(second.retryAfterMs).toBeGreaterThan(0);
		// 别的门店仍是全局额度,连打几下都放行
		for (let i = 0; i < 5; i++) expect((await quota.tryAcquireRequest("normal")).allowed).toBe(true);
		await quota.close();
		db.close();
	});
});