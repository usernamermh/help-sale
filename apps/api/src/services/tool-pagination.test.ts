import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import { openDatabase } from "../db/database.js";
import { requireTenant, upsertCustomer } from "../repositories/customers.js";
import { executeToolPage } from "./tool-pagination.js";

let db: DatabaseSync;

beforeEach(() => {
	db = openDatabase(":memory:");
	requireTenant(db, "t1", "演示租户");
});

afterEach(() => db.close());

describe("tool-pagination 手动翻页", () => {
	it("customer_query:按 page 返回对应页明细与原始表格", async () => {
		for (let i = 1; i <= 12; i++) {
			upsertCustomer(db, { tenantId: "t1", key: "c_page_" + String(i).padStart(2, "0"), name: "客户" + String(i).padStart(2, "0") });
		}
		const p1 = await executeToolPage({ db, tenantId: "t1" }, "customer_query", { view: "list", limit: 100, page: 1 });
		const d1 = p1.details as { customers: unknown[]; page: number; totalPages: number; hasMore: boolean; rawTable: string };
		expect(d1.page).toBe(1);
		expect(d1.totalPages).toBe(2);
		expect(d1.hasMore).toBe(true);
		expect(d1.customers).toHaveLength(10);
		expect(d1.rawTable).toContain("客户01");

		const p2 = await executeToolPage({ db, tenantId: "t1" }, "customer_query", { view: "list", limit: 100, page: 2 });
		const d2 = p2.details as { customers: unknown[]; page: number; hasMore: boolean; rawTable: string };
		expect(d2.page).toBe(2);
		expect(d2.hasMore).toBe(false);
		expect(d2.customers).toHaveLength(2);
		expect(d2.rawTable).toContain("客户12");
		expect(d2.rawTable).not.toContain("客户01");
	});

	it("excel:按 page 返回对应页 rows 与 rawTable", async () => {
		const XLSX = (await import("xlsx")) as typeof import("xlsx");
		const rows = [["序号", "客户"]];
		for (let i = 1; i <= 12; i++) rows.push([String(i), "客户" + i]);
		const wb = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "名单");
		const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
		const file = path.join(process.cwd(), ".tmp", `tp-xlsx-${Date.now()}.xlsx`);
		fs.writeFileSync(file, buf);
		try {
			const p1 = await executeToolPage({ db, tenantId: "t1" }, "excel", { filePath: file });
			const d1 = p1.details as { rows: unknown[][]; totalRows: number; totalPages: number; rawTable: string };
			expect(d1.totalRows).toBe(13);
			expect(d1.totalPages).toBe(2);
			expect(d1.rows).toHaveLength(10);
			expect(d1.rawTable).toContain("客户9");

			const p2 = await executeToolPage({ db, tenantId: "t1" }, "excel", { filePath: file, page: 2 });
			const d2 = p2.details as { rows: unknown[][]; page: number; rawTable: string };
			expect(d2.page).toBe(2);
			expect(d2.rows).toHaveLength(3);
			expect(d2.rawTable).toContain("客户12");
		} finally {
			fs.rmSync(file, { force: true });
		}
	});

	it("table_generate:按 page 返回对应页表格", async () => {
		const rows = [["序号", "客户"]];
		for (let i = 1; i <= 12; i++) rows.push([String(i), "客户" + i]);
		const p1 = await executeToolPage({ db, tenantId: "t1" }, "table_generate", { rows });
		const d1 = p1.details as { page: number; totalPages: number; table: string };
		expect(d1.page).toBe(1);
		expect(d1.totalPages).toBe(2);
		expect(d1.table).toContain("客户9");
		expect(d1.table).not.toContain("客户11");

		const p2 = await executeToolPage({ db, tenantId: "t1" }, "table_generate", { rows, page: 2 });
		const d2 = p2.details as { page: number; table: string };
		expect(d2.page).toBe(2);
		expect(d2.table).toContain("客户12");
	});

	it("非白名单工具拒绝执行", async () => {
		await expect(executeToolPage({ db, tenantId: "t1" }, "sql", {})).rejects.toThrow();
	});

	it("page 非法值拒绝", async () => {
		await expect(executeToolPage({ db, tenantId: "t1" }, "customer_query", { view: "list", page: 0 })).rejects.toThrow();
		await expect(executeToolPage({ db, tenantId: "t1" }, "customer_query", { view: "list", page: "abc" })).rejects.toThrow();
	});
});

	it("conversation_query:原文按 page 分页返回", async () => {
		const convId = "conv-page-1";
		db.prepare("INSERT INTO conversations (id, tenant_id, sales_name, message_count) VALUES (?,?,?,?)").run(convId, "t1", "销售A", 12);
		const ins = db.prepare("INSERT INTO conversation_messages (id, tenant_id, conversation_id, seq, speaker_role, speaker_name, content, spoken_at) VALUES (?,?,?,?,?,?,?,?)");
		for (let i = 1; i <= 12; i++) {
			ins.run(`m${i}`, "t1", convId, i, i % 2 ? "customer" : "sales", i % 2 ? "客户" : "销售", "内容" + i, `2026-01-01T00:00:0${i < 10 ? i : "9"}Z`);
		}
		const p1 = await executeToolPage({ db, tenantId: "t1" }, "conversation_query", { view: "load", conversationId: convId, page: 1 });
		const d1 = p1.details as { messages: unknown[]; page: number; totalPages: number; totalMessages: number; hasMore: boolean };
		expect(d1.messages).toHaveLength(10);
		expect(d1.totalMessages).toBe(12);
		expect(d1.totalPages).toBe(2);
		expect(d1.hasMore).toBe(true);

		const p2 = await executeToolPage({ db, tenantId: "t1" }, "conversation_query", { view: "load", conversationId: convId, page: 2 });
		const d2 = p2.details as { messages: unknown[]; page: number; hasMore: boolean };
		expect(d2.messages).toHaveLength(2);
		expect(d2.page).toBe(2);
		expect(d2.hasMore).toBe(false);
	});
