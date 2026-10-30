import { bool, num, str, strList, strMap } from "./primitives.js";
import type { FileConfig } from "./file.js";
import type { AppConfig, IntegrationsConfig } from "./types.js";

/**
 * 对应 help-sale.config.yaml 的 `mysql`、`redis`、`notification`、`tools`、`mcp` 五段:
 * 中间件连接与外部工具接入。全部必填 —— 不挂载对应工具时也要显式写空值
 * (如 tools.webSearch.apiKey: "" 与 mcp.servers: []),代码里不提供任何默认值。
 */
export function loadIntegrationsConfig(file: FileConfig): IntegrationsConfig {
	return {
		mysqlEnabled: bool(file.mysql?.enabled, "mysql.enabled"),
		mysqlSchemaRebuild: bool(file.mysql?.schemaRebuild, "mysql.schemaRebuild"),
		mysqlConnectTimeout: num(file.mysql?.connectTimeout, "mysql.connectTimeout"),
		mysqlHost: str(file.mysql?.host, "mysql.host"),
		mysqlPort: num(file.mysql?.port, "mysql.port"),
		mysqlUser: str(file.mysql?.user, "mysql.user"),
		mysqlPassword: str(file.mysql?.password, "mysql.password"),
		mysqlDatabase: str(file.mysql?.database, "mysql.database"),
		redisEnabled: bool(file.redis?.enabled, "redis.enabled"),
		redisHost: str(file.redis?.host, "redis.host"),
		redisPort: num(file.redis?.port, "redis.port"),
		redisPassword: str(file.redis?.password, "redis.password"),
		notificationEnabled: bool(file.notification?.enabled, "notification.enabled"),
		notificationWebhookUrl: str(file.notification?.webhookUrl, "notification.webhookUrl"),
		webSearchApiKey: str(file.tools?.webSearch?.apiKey, "tools.webSearch.apiKey"),
		fileWriteAllowOutsideRepo: bool(file.tools?.fileWrite?.allowOutsideRepo, "tools.fileWrite.allowOutsideRepo"),
		sqlMaxRows: num(file.tools?.sql?.maxRows, "tools.sql.maxRows"),
		sqlTimeoutMs: num(file.tools?.sql?.timeoutMs, "tools.sql.timeoutMs"),
		sqlExtraBlockedKeywords: strList(file.tools?.sql?.extraBlockedKeywords, "tools.sql.extraBlockedKeywords"),
		riskDangerousTools: strList(file.tools?.risk?.dangerousTools, "tools.risk.dangerousTools"),
		riskDangerousDefaultEnabled: bool(file.tools?.risk?.dangerousDefaultEnabled, "tools.risk.dangerousDefaultEnabled"),
		toolsCatalogEnabled: bool(file.tools?.catalog?.enabled, "tools.catalog.enabled"),
		toolsCatalogThreshold: num(file.tools?.catalog?.threshold, "tools.catalog.threshold"),
		toolsCatalogTopK: num(file.tools?.catalog?.topK, "tools.catalog.topK"),
		toolsCatalogMaxInspect: num(file.tools?.catalog?.maxInspect, "tools.catalog.maxInspect"),
		toolsCatalogSemanticFloorZh: num(file.tools?.catalog?.semanticFloorZh, "tools.catalog.semanticFloorZh"),
		toolsCatalogSemanticFloorEn: num(file.tools?.catalog?.semanticFloorEn, "tools.catalog.semanticFloorEn"),
		toolsCatalogBilingualEnabled: bool(file.tools?.catalog?.bilingual?.enabled, "tools.catalog.bilingual.enabled"),
		toolsCatalogRewriteTimeoutMs: num(file.tools?.catalog?.bilingual?.rewriteTimeoutMs, "tools.catalog.bilingual.rewriteTimeoutMs"),
		toolsCatalogPerLanguageTopK: num(file.tools?.catalog?.bilingual?.perLanguageTopK, "tools.catalog.bilingual.perLanguageTopK"),
		mcpServers: parseMcpServers(file.mcp?.servers),
	};
}

/**
 * MCP Server 列表:mcp.servers 必填(不接入也要显式写 `[]`),每条必须同时给出 name 与 url;
 * headers 可以不写,但写了就只能全是字符串 —— 不做"字段不全就静默跳过该条"的兜底。
 */
function parseMcpServers(value: unknown): AppConfig["mcpServers"] {
	if (!Array.isArray(value)) {
		throw new Error("配置项 mcp.servers 缺少数组(在 help-sale.config.yaml 中补齐;不接入请显式写 [])");
	}
	return value.map((server, index) => {
		const item = (server ?? {}) as { name?: unknown; url?: unknown; headers?: unknown };
		const headers = item.headers === undefined ? undefined : strMap(item.headers, `mcp.servers[${index}].headers`);
		return { name: str(item.name, `mcp.servers[${index}].name`), url: str(item.url, `mcp.servers[${index}].url`), headers, pat: (server as { pat?: unknown })?.pat === undefined ? undefined : str((server as { pat?: unknown }).pat, `mcp.servers[${index}].pat`) };
	});
}
