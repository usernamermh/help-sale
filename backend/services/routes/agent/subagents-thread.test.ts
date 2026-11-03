import { describe, expect, it } from "vitest";
import { openDatabase } from "../../../db/database.js";
import { listKanbanCards } from "./kanban.js";
import { requireTenant } from "../../../integrations_pi/tables/crm/customers.js";
import { execute as subagentsTool } from "../../../../tools_system/subagents/main.js";

/** 子代理建卡按会话落位:ctx.threadId 说了算,不再写死 default。 */
describe("subagents 工具:卡按会话落位", () => {
	it("传入 ctx.threadId 时卡落在该会话,default 里没有", () => {
		const db = openDatabase(":memory:");
		requireTenant(db, "t1", "测试租户");
		subagentsTool({ db, tenantId: "t1", threadId: "th-9" } as any, { op: "create", title: "查成交", goal: "统计上周成交" });
		expect(listKanbanCards(db, "t1", { threadId: "th-9" })).toHaveLength(1);
		expect(listKanbanCards(db, "t1", { threadId: "default" })).toHaveLength(0);
		db.close();
	});

	it("拿不到会话时回退 default(不会丢卡)", () => {
		const db = openDatabase(":memory:");
		requireTenant(db, "t1", "测试租户");
		subagentsTool({ db, tenantId: "t1" } as any, { op: "create", title: "查客户", goal: "列出客户" });
		expect(listKanbanCards(db, "t1", { threadId: "default" })).toHaveLength(1);
		db.close();
	});
});