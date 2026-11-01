/**
 * 租户级凭证解析:按租户读 tenant_secrets,缺项回退到全局配置。
 *
 * 这一层让"全局一套密钥"变成"默认全局 + 按租户覆盖":
 *   - 模型:model.modelId / model.baseUrl / model.apiKey / model.proxy;
 *   - 外部工具:tools.webSearch.apiKey;
 *   - 外部 MCP:mcp.servers(JSON 数组,结构同 mcp.servers)。
 */
import type { DatabaseSync } from "node:sqlite";
import { config } from "../env.js";
import { readTenantSecret } from "../integrations_pi/tables/agents/tenant-secrets.js";
import { createModelRegistry, type ModelRuntime } from "../integrations_pi/models.js";
import type { McpServerConfig } from "../mcp/client.js";

export interface ModelOverrides {
	modelId: string;
	baseUrl: string;
	apiKey: string;
	proxy: string;
}

/** 模型配置:租户覆盖优先,缺项回退全局。 */
export function tenantModelConfig(db: DatabaseSync, tenantId: string): ModelOverrides {
	return {
		modelId: readTenantSecret(db, tenantId, "model.modelId") ?? config.modelId,
		baseUrl: readTenantSecret(db, tenantId, "model.baseUrl") ?? config.modelBaseUrl,
		apiKey: readTenantSecret(db, tenantId, "model.apiKey") ?? config.modelApiKey,
		proxy: readTenantSecret(db, tenantId, "model.proxy") ?? config.modelProxy,
	};
}

/** web_search 工具的密钥:租户覆盖优先。 */
export function tenantWebSearchKey(db: DatabaseSync, tenantId: string): string {
	return readTenantSecret(db, tenantId, "tools.webSearch.apiKey") ?? config.webSearchApiKey;
}

/** 外部 MCP server 列表:租户覆盖(JSON 数组)优先,解析失败按空列表处理并告警。 */
export function tenantMcpServers(db: DatabaseSync, tenantId: string): McpServerConfig[] {
	const raw = readTenantSecret(db, tenantId, "mcp.servers");
	if (raw === undefined || raw.trim() === "") return config.mcpServers;
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) throw new Error("不是数组");
		return parsed.filter((item): item is McpServerConfig => Boolean(item && typeof item === "object" && typeof (item as McpServerConfig).name === "string" && typeof (item as McpServerConfig).url === "string"));
	} catch (error) {
		console.warn(`[tenant-secrets] 租户 ${tenantId} 的 mcp.servers 解析失败,已回退全局:${error instanceof Error ? error.message : String(error)}`);
		return config.mcpServers;
	}
}

/** 模型配置指纹:用于"配置没变就复用运行时"的缓存键。 */
export function modelConfigFingerprint(overrides: ModelOverrides): string {
	return [overrides.modelId, overrides.baseUrl, overrides.apiKey, overrides.proxy].join("|");
}

const runtimeCache = new Map<string, ModelRuntime>();

/**
 * 取该租户的模型运行时:同一份配置只建一次(createModelRegistry 会建 provider + fetch 链)。
 * 凭证改了(指纹变了)自然落到新实例。
 */
export function modelRuntimeFor(db: DatabaseSync, tenantId: string): ModelRuntime {
	const overrides = tenantModelConfig(db, tenantId);
	const key = modelConfigFingerprint(overrides);
	const cached = runtimeCache.get(key);
	if (cached) return cached;
	const runtime = createModelRegistry(overrides);
	runtimeCache.set(key, runtime);
	return runtime;
}

/** 测试用:清掉运行时缓存。 */
export function resetModelRuntimeCache(): void {
	runtimeCache.clear();
}