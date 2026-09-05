import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

// 所有运行配置由 help-sale.config.yaml 提供,代码内不写任何默认值。
export interface AppConfig {
	host: string;
	port: number;
	dataMode: "local" | "mysql";
	dataDir: string;
	databaseId: string;
	tables: Record<string, string>;
	businessDbPath: string;
	sessionDbPath: string;
	modelProvider: string;
	modelId: string;
	modelBaseUrl: string;
	modelApiKey: string;
	modelProxy: string;
	modelContextWindow: number;
	modelMaxTokens: number;
	modelExtraBody: Record<string, unknown>;
	logEnabled: boolean;
	logDir: string;
	logMaxBytes: number;
	knowledgeSearchLimit: number;
	mysqlEnabled: boolean;
	mysqlSchemaRebuild: boolean;
	mysqlConnectTimeout: number;
	mysqlHost: string;
	mysqlPort: number;
	mysqlUser: string;
	mysqlPassword: string;
	mysqlDatabase: string;
	redisEnabled: boolean;
	redisHost: string;
	redisPort: number;
	redisPassword: string;
	chunkerSize: number;
	chunkerOverlap: number;
	notificationEnabled: boolean;
	notificationWebhookUrl: string;
	companyName: string;
	teamName: string;
	tenantId: string;
	// 业务默认值(defaults 段)
	insightsDays: number;
	improvementsDays: number;
	conversationsLimit: number;
	dealsLimit: number;
	storeOverviewDays: number;
	customersLimit: number;
	knowledgeCandidatesLimit: number;
	agentThreadsLimit: number;
	transcriptLimit: number;
	agentListLimit: number;
	notificationScanLimit: number;
	remindersTakeLimit: number;
	analysisHistoryLimit: number;
	vehicleSearchLimit: number;
}

export interface FileConfig {
	server?: { host?: string; port?: number };
	data?: {
		mode?: "local" | "mysql";
		databaseId?: string;
		tables?: Record<string, string>;
		dataDir?: string;
		businessDbPath?: string;
		sessionDbPath?: string;
	};
	tenant?: { defaultTenantId?: string };
	model?: {
		provider?: string;
		modelId?: string;
		baseUrl?: string;
		apiKey?: string;
		proxy?: string;
		contextWindow?: number;
		maxTokens?: number;
		extraBody?: Record<string, unknown>;
	};
	chunker?: { size?: number; overlap?: number };
	knowledge?: { searchLimit?: number };
	logging?: { enabled?: boolean; dir?: string; maxBytes?: number };
	mysql?: { enabled?: boolean; schemaRebuild?: boolean; connectTimeout?: number; host?: string; port?: number; user?: string; password?: string; database?: string };
	redis?: { enabled?: boolean; host?: string; port?: number; password?: string };
	notification?: { enabled?: boolean; webhookUrl?: string };
	company?: { name?: string; team?: string };
	defaults?: {
		insightsDays?: number;
		improvementsDays?: number;
		conversationsLimit?: number;
		dealsLimit?: number;
		storeOverviewDays?: number;
		customersLimit?: number;
		knowledgeCandidatesLimit?: number;
		agentThreadsLimit?: number;
		transcriptLimit?: number;
		agentListLimit?: number;
		notificationScanLimit?: number;
		remindersTakeLimit?: number;
		analysisHistoryLimit?: number;
		vehicleSearchLimit?: number;
	};
}

export function locateConfigFile(): string | undefined {
	const override = process.env.CONFIG_PATH;
	if (override) return override;
	// 本文件位于 apps/api/src/env.ts,向上三级即仓库顶层
	const here = path.dirname(fileURLToPath(import.meta.url));
	const candidate = path.resolve(here, "..", "..", "..", "help-sale.config.yaml");
	return existsSync(candidate) ? candidate : undefined;
}

export function loadConfigFile(): FileConfig {
	const file = locateConfigFile();
	if (!file) return {};
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch (error) {
		throw new Error(`无法读取配置文件 ${file}: ${(error as Error).message}`);
	}
	try {
		return (parseYaml(raw) ?? {}) as FileConfig;
	} catch (error) {
		throw new Error(`配置文件 ${file} 不是合法 YAML: ${(error as Error).message}`);
	}
}

export function loadEnv(): void {
	if (typeof process.loadEnvFile === "function") {
		try {
			process.loadEnvFile?.();
		} catch {
			// 没有 .env 文件时忽略,使用系统环境变量
		}
	} else if (process.env.NODE_ENV !== "test") {
		console.warn("[env] loadEnvFile 不可用,请手动注入环境变量");
	}
}

function safeParseJson(raw: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(raw) as unknown;
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/** 布尔解析:必须能从配置/环境得到明确值,不允许代码内兜底默认。 */
function bool(value: unknown): boolean {
	if (typeof value === "boolean") return value;
	if (value === undefined || value === null || value === "") {
		throw new Error("配置文件缺少布尔字段(在 help-sale.config.yaml 中补齐)");
	}
	return String(value).toLowerCase() === "true" || String(value) === "1";
}

/** 数值解析:必须能从配置/环境得到明确值,不允许代码内兜底默认。 */
function num(value: unknown): number {
	const n = Number(value);
	if (Number.isFinite(n)) return n;
	throw new Error("配置文件缺少数值字段(在 help-sale.config.yaml 中补齐)");
}


/** 数据存储模式枚举校验:只允许 local / mysql,缺省或非法抛错(不允许代码内默认)。 */
function storageMode(value: unknown): "local" | "mysql" {
	const v = String(value ?? "").trim().toLowerCase();
	if (v === "local" || v === "mysql") return v as "local" | "mysql";
	throw new Error(`配置项目 data.mode 必须为 local 或 mysql(当前:${String(value)})`);
}

/** 业务表名映射校验:必须覆盖全部逻辑表,缺失或非法抛错(yaml data.tables 是唯一事实源)。 */
function parseTables(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object") {
		throw new Error("配置项 data.tables 缺失:请在 help-sale.config.yaml 的 data.tables 中配置全部业务表名");
	}
	const inTables = value as Record<string, unknown>;
	const required = [
		"tenants", "customers", "conversations", "conversation_messages", "analyses", "next_step_tasks",
		"knowledge_documents", "knowledge_chunks", "knowledge_candidates", "agent_events", "customer_tags",
		"notification_logs", "stores", "sales", "deals", "tool_call_cache", "digests",
	];
	const out: Record<string, string> = {};
	for (const key of required) {
		const tableName = inTables[key];
		if (typeof tableName !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) {
			throw new Error(`配置项 data.tables.${key} 缺失或非法(应为合法表名):${String(tableName)}`);
		}
		out[key] = tableName;
	}
	return out;
}
export function loadConfig(): AppConfig {
	const file = loadConfigFile();
	// 优先级:配置文件 < 环境变量(可覆盖单项;CONFIG_PATH 可换文件)
	const env = process.env;
	return {
		host: env.HOST ?? file.server!.host!,
		port: num(env.PORT ?? file.server!.port!),
		dataMode: storageMode(env.DATA_MODE ?? file.data!.mode!),
		databaseId: env.DATABASE_ID ?? file.data!.databaseId!,
		tables: parseTables(file.data!.tables!),
		dataDir: env.DATA_DIR ?? file.data!.dataDir!,
		businessDbPath: env.BUSINESS_DB ?? file.data!.businessDbPath!,
		sessionDbPath: env.SESSION_DB ?? file.data!.sessionDbPath!,
		modelProvider: env.MODEL_PROVIDER ?? file.model!.provider!,
		modelId: env.MODEL_ID ?? file.model!.modelId!,
		modelBaseUrl: env.MODEL_BASE_URL ?? file.model!.baseUrl!,
		modelApiKey: env.MODEL_API_KEY ?? file.model!.apiKey!,
		modelProxy: env.MODEL_PROXY ?? file.model!.proxy!,
		modelContextWindow: num(env.MODEL_CONTEXT_WINDOW ?? file.model!.contextWindow!),
		modelMaxTokens: num(env.MODEL_MAX_TOKENS ?? file.model!.maxTokens!),
		modelExtraBody:
			env.MODEL_EXTRA_BODY !== undefined ? (safeParseJson(env.MODEL_EXTRA_BODY) ?? {}) : (file.model!.extraBody ?? {}),
		logEnabled: bool(env.LOG_ENABLED ?? file.logging!.enabled!),
		logDir: env.LOG_DIR ?? file.logging!.dir!,
		logMaxBytes: num(env.LOG_MAX_BYTES ?? file.logging!.maxBytes!),
		knowledgeSearchLimit: num(env.KNOWLEDGE_SEARCH_LIMIT ?? file.knowledge!.searchLimit!),
		mysqlEnabled: bool(env.MYSQL_ENABLED ?? file.mysql!.enabled!),
		mysqlSchemaRebuild: bool(env.MYSQL_SCHEMA_REBUILD ?? file.mysql!.schemaRebuild!),
		mysqlConnectTimeout: num(env.MYSQL_CONNECT_TIMEOUT ?? file.mysql!.connectTimeout!),
		mysqlHost: env.MYSQL_HOST ?? file.mysql!.host!,
		mysqlPort: num(env.MYSQL_PORT ?? file.mysql!.port!),
		mysqlUser: env.MYSQL_USER ?? file.mysql!.user!,
		mysqlPassword: env.MYSQL_PASSWORD ?? file.mysql!.password!,
		mysqlDatabase: env.MYSQL_DATABASE ?? file.mysql!.database!,
		redisEnabled: bool(env.REDIS_ENABLED ?? file.redis!.enabled!),
		redisHost: env.REDIS_HOST ?? file.redis!.host!,
		redisPort: num(env.REDIS_PORT ?? file.redis!.port!),
		redisPassword: env.REDIS_PASSWORD ?? file.redis!.password!,
		chunkerSize: num(env.CHUNKER_SIZE ?? file.chunker!.size!),
		chunkerOverlap: num(env.CHUNKER_OVERLAP ?? file.chunker!.overlap!),
		notificationEnabled: bool(env.NOTIFICATION_ENABLED ?? file.notification!.enabled!),
		notificationWebhookUrl: env.NOTIFICATION_WEBHOOK_URL ?? file.notification!.webhookUrl!,
		companyName: env.COMPANY_NAME ?? file.company!.name!,
		teamName: env.TEAM_NAME ?? file.company!.team!,
		tenantId: env.TENANT_ID ?? file.tenant!.defaultTenantId!,
		insightsDays: num(env.INSIGHTS_DAYS ?? file.defaults!.insightsDays!),
		improvementsDays: num(env.IMPROVEMENTS_DAYS ?? file.defaults!.improvementsDays!),
		conversationsLimit: num(env.CONVERSATIONS_LIMIT ?? file.defaults!.conversationsLimit!),
		dealsLimit: num(env.DEALS_LIMIT ?? file.defaults!.dealsLimit!),
		storeOverviewDays: num(env.STORE_OVERVIEW_DAYS ?? file.defaults!.storeOverviewDays!),
		customersLimit: num(env.CUSTOMERS_LIMIT ?? file.defaults!.customersLimit!),
		knowledgeCandidatesLimit: num(env.KNOWLEDGE_CANDIDATES_LIMIT ?? file.defaults!.knowledgeCandidatesLimit!),
		agentThreadsLimit: num(env.AGENT_THREADS_LIMIT ?? file.defaults!.agentThreadsLimit!),
		transcriptLimit: num(env.TRANSCRIPT_LIMIT ?? file.defaults!.transcriptLimit!),
		agentListLimit: num(env.AGENT_LIST_LIMIT ?? file.defaults!.agentListLimit!),
		notificationScanLimit: num(env.NOTIFICATION_SCAN_LIMIT ?? file.defaults!.notificationScanLimit!),
		remindersTakeLimit: num(env.REMINDERS_TAKE_LIMIT ?? file.defaults!.remindersTakeLimit!),
		analysisHistoryLimit: num(env.ANALYSIS_HISTORY_LIMIT ?? file.defaults!.analysisHistoryLimit!),
		vehicleSearchLimit: num(env.VEHICLE_SEARCH_LIMIT ?? file.defaults!.vehicleSearchLimit!),
	};
}

/** 应用全局配置实例:各模块顶部直接 import { config } 使用,不再经过函数入参传递。 */
export const config: AppConfig = loadConfig();