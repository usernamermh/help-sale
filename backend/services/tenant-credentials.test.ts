import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { deleteTenantSecret, listTenantSecrets, readTenantSecret, writeTenantSecret } from "../integrations_pi/tables/agents/tenant-secrets.js";
import { modelRuntimeFor, resetModelRuntimeCache, tenantMcpServers, tenantModelConfig, tenantWebSearchKey } from "./tenant-credentials.js";
import { config } from "../env.js";

/** 每租户凭证:覆盖优先、缺项回退全局、运行时按配置指纹缓存。 */

function memoryDb(): DatabaseSync {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE tenants (id TEXT PRIMARY KEY, name TEXT, slug TEXT)");
	db.exec("INSERT INTO tenants (id, name, slug) VALUES ('t1','甲','t1')");
	db.exec("INSERT INTO tenants (id, name, slug) VALUES ('t2','乙','t2')");
	db.exec(
		`CREATE TABLE tenant_secrets (
			tenant_id TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL,
			updated_at TEXT NOT NULL DEFAULT '',
			PRIMARY KEY (tenant_id, name))`,
	);
	return db;
}

describe("租户凭证存取", () => {
	it("写入后可读、可列、可删,租户之间互不可见", () => {
		const db = memoryDb();
		writeTenantSecret(db, "t1", "tools.webSearch.apiKey", "key-1");
		expect(readTenantSecret(db, "t1", "tools.webSearch.apiKey")).toBe("key-1");
		expect(readTenantSecret(db, "t2", "tools.webSearch.apiKey")).toBeUndefined();
		expect(listTenantSecrets(db, "t1").map((r) => r.name)).toEqual(["tools.webSearch.apiKey"]);
		// 覆盖写入走 upsert,不报重复
		writeTenantSecret(db, "t1", "tools.webSearch.apiKey", "key-2");
		expect(readTenantSecret(db, "t1", "tools.webSearch.apiKey")).toBe("key-2");
		expect(deleteTenantSecret(db, "t1", "tools.webSearch.apiKey")).toBe(true);
		expect(readTenantSecret(db, "t1", "tools.webSearch.apiKey")).toBeUndefined();
		db.close();
	});
});

describe("凭证解析:租户覆盖优先,缺项回退全局", () => {
	it("模型端点/密钥按租户覆盖,没覆盖的项用全局", () => {
		const db = memoryDb();
		const before = tenantModelConfig(db, "t1");
		expect(before.modelId).toBe(config.modelId);
		expect(before.apiKey).toBe(config.modelApiKey);
		writeTenantSecret(db, "t1", "model.apiKey", "tenant-key");
		writeTenantSecret(db, "t1", "model.baseUrl", "https://tenant.example/v1");
		const after = tenantModelConfig(db, "t1");
		expect(after.apiKey).toBe("tenant-key");
		expect(after.baseUrl).toBe("https://tenant.example/v1");
		expect(after.modelId).toBe(config.modelId);
		expect(tenantModelConfig(db, "t2").apiKey).toBe(config.modelApiKey);
		db.close();
	});

	it("web_search key 与 MCP 列表同样支持覆盖;坏 JSON 回退全局", () => {
		const db = memoryDb();
		expect(tenantWebSearchKey(db, "t1")).toBe(config.webSearchApiKey);
		writeTenantSecret(db, "t1", "tools.webSearch.apiKey", "tenant-serper");
		expect(tenantWebSearchKey(db, "t1")).toBe("tenant-serper");

		expect(tenantMcpServers(db, "t1")).toEqual(config.mcpServers);
		writeTenantSecret(db, "t1", "mcp.servers", JSON.stringify([{ name: "own", url: "https://own.example/mcp", pat: "p" }]));
		expect(tenantMcpServers(db, "t1")).toEqual([{ name: "own", url: "https://own.example/mcp", pat: "p" }]);
		writeTenantSecret(db, "t2", "mcp.servers", "{坏 JSON");
		expect(tenantMcpServers(db, "t2")).toEqual(config.mcpServers);
		db.close();
	});

	it("运行时缓存按配置指纹复用:同配置同实例,换密钥换实例", () => {
		const db = memoryDb();
		resetModelRuntimeCache();
		const a = modelRuntimeFor(db, "t1");
		const b = modelRuntimeFor(db, "t1");
		expect(a).toBe(b);
		writeTenantSecret(db, "t1", "model.apiKey", "another-key");
		const c = modelRuntimeFor(db, "t1");
		expect(c).not.toBe(a);
		expect(c.modelId).toBe(config.modelId);
		db.close();
	});
});