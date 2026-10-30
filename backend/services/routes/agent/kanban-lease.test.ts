import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../../../db/database.js";
import { requireTenant } from "../../../integrations_pi/tables/crm/customers.js";
import { claimKanbanCard, createKanbanTask, finishKanbanCard, getKanbanCard, reclaimExpiredKanbanCards, renewKanbanLease } from "./kanban.js";

let db: DatabaseSync;
const LEASE = 600_000;

beforeEach(() => {
	db = openDatabase(":memory:");
	requireTenant(db, "t1", "演示租户");
});
afterEach(() => db.close());

function newCard(): string {
	return createKanbanTask(db, { tenantId: "t1", threadId: "th1", title: "子任务", goal: "查客户" }).id;
}

describe("子任务卡的领取与租约(多实例安全)", () => {
	it("原子领取:同一张卡只有一个执行者能抢到", () => {
		const id = newCard();
		expect(claimKanbanCard(db, "t1", id, { owner: "实例A", leaseMs: LEASE })).toBe(true);
		// 第二个实例(或第二个入口)同时扫到同一张卡:抢不到,必须跳过
		expect(claimKanbanCard(db, "t1", id, { owner: "实例B", leaseMs: LEASE })).toBe(false);
		const card = getKanbanCard(db, "t1", id)!;
		expect(card.ownerInstance).toBe("实例A");
		expect(card.status).toBe("inprogress");
		expect(card.attempts).toBe(1);
		expect(card.leaseExpiresAt).toBeTruthy();
	});

	it("续租只有持有者能刷,别人刷不动", () => {
		const id = newCard();
		claimKanbanCard(db, "t1", id, { owner: "实例A", leaseMs: LEASE });
		expect(renewKanbanLease(db, "t1", id, "实例A", LEASE)).toBe(true);
		expect(renewKanbanLease(db, "t1", id, "实例B", LEASE)).toBe(false);
	});

	it("租约过期:卡回到 pending 让别的实例接管;超过重试上限判 error", () => {
		const id = newCard();
		claimKanbanCard(db, "t1", id, { owner: "实例A", leaseMs: LEASE });
		// 把租约改成已过期(模拟领取者崩溃)
		db.prepare("UPDATE kanban_cards SET lease_expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), id);
		const reclaimed = reclaimExpiredKanbanCards(db, "t1", { maxAttempts: 3 });
		expect(reclaimed).toBe(1);
		const card = getKanbanCard(db, "t1", id)!;
		expect(card.status).toBe("pending");
		expect(card.ownerInstance).toBeUndefined();
		// 再被领取两次后 attempts=3,过期就放弃
		claimKanbanCard(db, "t1", id, { owner: "实例B", leaseMs: LEASE });
		db.prepare("UPDATE kanban_cards SET lease_expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), id);
		reclaimExpiredKanbanCards(db, "t1", { maxAttempts: 3 });
		claimKanbanCard(db, "t1", id, { owner: "实例C", leaseMs: LEASE });
		db.prepare("UPDATE kanban_cards SET lease_expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), id);
		reclaimExpiredKanbanCards(db, "t1", { maxAttempts: 3 });
		const gaveUp = getKanbanCard(db, "t1", id)!;
		expect(gaveUp.status).toBe("error");
		expect(gaveUp.error).toContain("已放弃");
	});

	it("执行结束清掉领取归属与租约", () => {
		const id = newCard();
		claimKanbanCard(db, "t1", id, { owner: "实例A", leaseMs: LEASE });
		finishKanbanCard(db, "t1", id, { ok: true, result: "结果" });
		const card = getKanbanCard(db, "t1", id)!;
		expect(card.status).toBe("done");
		expect(card.ownerInstance).toBeUndefined();
		expect(card.leaseExpiresAt).toBeUndefined();
	});
});