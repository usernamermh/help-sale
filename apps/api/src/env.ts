import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

// 所有运行配置只从 help-sale.config.yaml 读取,不允许环境变量覆盖。
// 唯一例外:CONFIG_PATH 仅用于指定配置文件路径(不是配置项本身)。
export interface AppConfig {
	host: string;
	port: number;
	dataMode: "local" | "mysql";
	dataDir: string;
	memoryFile: string;
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
		memoryFile?: string;
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

/** 布尔解析:必须能从配置得到明确值,不允许代码内兜底默认。 */
function bool(value: unknown): boolean {
	if (typeof value === "boolean") return value;
	if (value === undefined || value === null || value === "") {
		throw new Error("配置文件缺少布尔字段(在 help-sale.config.yaml 中补齐)");
	}
	return String(value).toLowerCase() === "true" || String(value) === "1";
}

/** 数值解析:必须能从配置得到明确值,不允许代码内兜底默认。 */
function num(value: unknown): number {
	const n = Number(value);
	if (Number.isFinite(n)) return n;
	throw new Error("配置缺少数值字段(在 help-sale.config.yaml 中补齐)");
}

/** 数据存储模式枚举校验:只允许 local / mysql,缺省或非法抛错。 */
function storageMode(value: unknown): "local" | "mysql" {
	const v = String(value ?? "").trim().toLowerCase();
	if (v === "local" || v === "mysql") return v as "local" | "mysql";
	throw new Error(`配置项目 data.mode 必须为 local 或 mysql(当前:${String(value)})`);
}

/** 业务表名映射校验:必须覆盖全部逻辑表,缺失或非法抛错(data.tables 是唯一事实源)。 */
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
	return {
		host: file.server!.host!,
		port: num(file.server!.port!),
		dataMode: storageMode(file.data!.mode!),
		databaseId: file.data!.databaseId!,
		tables: parseTables(file.data!.tables!),
		dataDir: file.data!.dataDir!,
		memoryFile: file.data!.memoryFile!,
		businessDbPath: file.data!.businessDbPath!,
		sessionDbPath: file.data!.sessionDbPath!,
		modelProvider: file.model!.provider!,
		modelId: file.model!.modelId!,
		modelBaseUrl: file.model!.baseUrl!,
		modelApiKey: file.model!.apiKey!,
		modelProxy: file.model!.proxy!,
		modelContextWindow: num(file.model!.contextWindow!),
		modelMaxTokens: num(file.model!.maxTokens!),
		modelExtraBody: file.model!.extraBody ?? {},
		logEnabled: bool(file.logging!.enabled!),
		logDir: file.logging!.dir!,
		logMaxBytes: num(file.logging!.maxBytes!),
		knowledgeSearchLimit: num(file.knowledge!.searchLimit!),
		mysqlEnabled: bool(file.mysql!.enabled!),
		mysqlSchemaRebuild: bool(file.mysql!.schemaRebuild!),
		mysqlConnectTimeout: num(file.mysql!.connectTimeout!),
		mysqlHost: file.mysql!.host!,
		mysqlPort: num(file.mysql!.port!),
		mysqlUser: file.mysql!.user!,
		mysqlPassword: file.mysql!.password!,
		mysqlDatabase: file.mysql!.database!,
		redisEnabled: bool(file.redis!.enabled!),
		redisHost: file.redis!.host!,
		redisPort: num(file.redis!.port!),
		redisPassword: file.redis!.password!,
		chunkerSize: num(file.chunker!.size!),
		chunkerOverlap: num(file.chunker!.overlap!),
		notificationEnabled: bool(file.notification!.enabled!),
		notificationWebhookUrl: file.notification!.webhookUrl!,
		companyName: file.company!.name!,
		teamName: file.company!.team!,
		tenantId: file.tenant!.defaultTenantId!,
		insightsDays: num(file.defaults!.insightsDays!),
		improvementsDays: num(file.defaults!.improvementsDays!),
		conversationsLimit: num(file.defaults!.conversationsLimit!),
		dealsLimit: num(file.defaults!.dealsLimit!),
		storeOverviewDays: num(file.defaults!.storeOverviewDays!),
		customersLimit: num(file.defaults!.customersLimit!),
		knowledgeCandidatesLimit: num(file.defaults!.knowledgeCandidatesLimit!),
		agentThreadsLimit: num(file.defaults!.agentThreadsLimit!),
		transcriptLimit: num(file.defaults!.transcriptLimit!),
		agentListLimit: num(file.defaults!.agentListLimit!),
		notificationScanLimit: num(file.defaults!.notificationScanLimit!),
		remindersTakeLimit: num(file.defaults!.remindersTakeLimit!),
		analysisHistoryLimit: num(file.defaults!.analysisHistoryLimit!),
		vehicleSearchLimit: num(file.defaults!.vehicleSearchLimit!),
	};
}

/** 应用全局配置实例:各模块顶部直接 import { config } 使用,配置只来自 yaml。 */
export const config: AppConfig = loadConfig();