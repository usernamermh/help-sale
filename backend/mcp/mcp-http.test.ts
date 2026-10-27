import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { openSessionStore, tmpDataDir, cleanupDataDir, type SessionStore } from "../integrations_pi/sessions.js";
import { createMemoryReminderQueue } from "../integrations_db/reminder-queue.js";

let app: FastifyInstance;
let store: SessionStore;
let dir: string;

beforeEach(async () => {
	dir = tmpDataDir("mcp-http");
	store = openSessionStore(dir);
	app = buildApp({ dataDir: dir, ensureTenant: false, reminders: createMemoryReminderQueue() });
});

afterEach(async () => {
	await app.close();
	await store.close();
	cleanupDataDir(dir);
});

describe("MCP HTTP 端点", () => {
	it("POST /mcp initialize 返回协议信息", async () => {
		const res = await app.inject({
			method: "POST",
			url: "/mcp",
			payload: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
			headers: { "x-tenant-id": "t_demo" },
		});
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.result.serverInfo.name).toBe("help-sale-mcp");
	});

	it("POST /mcp tools/list 返回工具列表(含 customer_query)", async () => {
		const res = await app.inject({
			method: "POST",
			url: "/mcp",
			payload: { jsonrpc: "2.0", id: 2, method: "tools/list" },
			headers: { "x-tenant-id": "t_demo" },
		});
		expect(res.statusCode).toBe(200);
		const body = res.json();
		const names = body.result.tools.map((t: any) => t.name);
		expect(names).toContain("mcp_help_sale_customer_query");
		expect(names).toContain("mcp_help_sale_knowledge_search");
	});

	it("POST /mcp tools/call 调用 customer_query", async () => {
		const res = await app.inject({
			method: "POST",
			url: "/mcp",
			payload: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "mcp_help_sale_customer_query", arguments: { view: "list" } } },
			headers: { "x-tenant-id": "t_demo" },
		});
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.error).toBeUndefined();
		expect(body.result.isError).toBe(false);
		expect(JSON.stringify(body.result.content)).toContain("客户");
	});
});
