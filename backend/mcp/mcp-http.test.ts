import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { openSessionStore, tmpDataDir, cleanupDataDir, type SessionStore } from "../integrations_pi/sessions.js";
import { createMemoryReminderQueue } from "../integrations_db/reminder-queue.js";
import { config } from "../env.js";

let app: FastifyInstance;
let store: SessionStore;
let dir: string;
/** 开启登录后,/mcp 也要凭证:先用初始管理员换令牌,再带上(客户端用 API Key 或令牌都行) */
let authHeaders: Record<string, string> = {};

beforeEach(async () => {
	dir = tmpDataDir("mcp-http");
	store = openSessionStore(dir);
	app = buildApp({ dataDir: dir, reminders: createMemoryReminderQueue() });
	const login = await app.inject({
		method: "POST",
		url: "/api/v1/auth/login",
		payload: { username: config.authBootstrapUsername, password: config.authBootstrapPassword },
		headers: { "x-tenant-id": config.authBootstrapTenantId },
	});
	authHeaders = { authorization: `Bearer ${login.json().token}` };
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
			headers: authHeaders,
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
			headers: authHeaders,
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
			headers: authHeaders,
		});
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.error).toBeUndefined();
		expect(body.result.isError).toBe(false);
		expect(JSON.stringify(body.result.content)).toContain("客户");
	});
	it("不接受绕过租户解析的请求头:非受信租户一律 403", async () => {
		const res = await app.inject({
			method: "POST",
			url: "/mcp",
			payload: { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "mcp_help_sale_customer_query", arguments: { view: "list" } } },
			headers: { "x-tenant-id": "t_other" },
		});
		expect(res.statusCode).toBe(403);
		expect(res.json().error).toBe("tenant_not_allowed");
	});
});
