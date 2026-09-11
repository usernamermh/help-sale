import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../db/database.js";
import { requireTenant, upsertCustomer } from "./customers.js";
import { setFunnelStage, getFunnelStats, listSilentCustomers, FUNNEL_STAGES } from "./funnel.js";

let db: DatabaseSync;
beforeEach(() => {
	db = openDatabase(":memory:");
	requireTenant(db, "t1", "演示租户");
});
afterEach(() => db.close());

describe("销售漏斗", () => {
	it("阶段流转:设置阶段与战败原因,非法阶段拒绝", () => {
		const c = upsertCustomer(db, { tenantId: "t1", key: "c_1", name: "王总" });
		const moved = setFunnelStage(db, "t1", "c_1", "test_drive")!;
		expect(moved.funnelStage).toBe("test_drive");
		const lost = setFunnelStage(db, "t1", "c_1", "closed_lost", "price")!;
		expect(lost.funnelStage).toBe("closed_lost");
		expect(lost.lostReason).toBe("price");
		expect(() => setFunnelStage(db, "t1", "c_1", "bad_stage")).toThrow();
		expect(FUNNEL_STAGES).toContain("closed_won");
		expect(c.key).toBeTruthy();
	});

	it("漏斗统计:各阶段数量/转化率/战败原因分布", () => {
		upsertCustomer(db, { tenantId: "t1", key: "c_1", name: "A" });
		upsertCustomer(db, { tenantId: "t1", key: "c_2", name: "B" });
		upsertCustomer(db, { tenantId: "t1", key: "c_3", name: "C" });
		setFunnelStage(db, "t1", "c_2", "test_drive");
		setFunnelStage(db, "t1", "c_3", "closed_won");
		upsertCustomer(db, { tenantId: "t1", key: "c_4", name: "D" });
		setFunnelStage(db, "t1", "c_4", "closed_lost", "competitor");

		const stats = getFunnelStats(db, "t1");
		expect(stats.total).toBe(4);
		const stageOf = (s: string) => stats.stages.find((x) => x.stage === s);
		expect(stageOf("new")!.count).toBe(1);
		expect(stageOf("test_drive")!.count).toBe(1);
		expect(stageOf("closed_won")!.count).toBe(1);
		expect(stageOf("closed_lost")!.count).toBe(1);
		const wonRate = stats.conversions.find((c) => c.to === "成交")!;
		expect(wonRate.rate).toBeCloseTo(0.25);
		expect(stats.lostReasons.find((r) => r.reason === "competitor")!.count).toBe(1);
	});

	it("沉默客户:无会话/任务/试驾且未成交战败的客户进入名单", () => {
		const active = upsertCustomer(db, { tenantId: "t1", key: "c_active", name: "活跃客户" });
		db.prepare(
			"INSERT INTO conversations (id, tenant_id, customer_id, sales_name, message_count, updated_at) VALUES (?,?,?,?,?,?)",
		).run("cv1", "t1", active.id, "销售A", 1, new Date().toISOString());

		upsertCustomer(db, { tenantId: "t1", key: "c_silent", name: "沉默客户" });
		db.prepare("UPDATE customers SET updated_at = datetime('now', '-30 days') WHERE key = 'c_silent'").run();

		upsertCustomer(db, { tenantId: "t1", key: "c_won", name: "已成交" });
		setFunnelStage(db, "t1", "c_won", "closed_won");

		const silent = listSilentCustomers(db, "t1", 7);
		expect(silent.map((s) => s.key)).toEqual(["c_silent"]);
	});
});