import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

export interface AppConfig {
	host: string;
	port: number;
	dataDir: string;
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
	knowledgeSearchLimit: number;
	mysqlEnabled: boolean;
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
	tenantId: string; // MVP:固定演示租户,后续迁移到认证
}

export interface FileConfig {
	server?: { host?: string; port?: number };
	data?: { dataDir?: string };
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
	mysql?: { enabled?: boolean; host?: string; port?: number; user?: string; password?: string; database?: string };
	redis?: { enabled?: boolean; host?: string; port?: number; password?: string };
	notification?: { enabled?: boolean; webhookUrl?: string };
	company?: { name?: string; team?: string };
}

export const CONFIG_FILE_NAME = "help-sale.config.yaml";

export function locateConfigFile(): string | undefined {
	const override = process.env.CONFIG_PATH;
	if (override) return override;
	// 本文件位于 apps/api/src/env.ts,向上三级即仓库顶层
	const here = path.dirname(fileURLToPath(import.meta.url));
	const candidate = path.resolve(here, "..", "..", "..", CONFIG_FILE_NAME);
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

const defaults: AppConfig = {
	host: "0.0.0.0",
	port: 3000,
	dataDir: "apps/api/data",
	businessDbPath: "apps/api/data/business.db",
	sessionDbPath: "apps/api/data/pi-sessions.db",
	modelProvider: "local-llm",
	modelId: "u21-preview",
	modelBaseUrl: "http://10.252.60.39:31883/v1",
	modelApiKey: "sk-1234",
	modelProxy: "http://10.252.60.14:3128",
	modelContextWindow: 32768,
	modelMaxTokens: 8192,
	modelExtraBody: {},
	knowledgeSearchLimit: 5,
	mysqlEnabled: true,
	mysqlHost: "10.10.20.53",
	mysqlPort: 3306,
	mysqlUser: "root",
	mysqlPassword: "rmh_mysql_2026",
	mysqlDatabase: "help_sale",
	redisEnabled: true,
	redisHost: "10.10.20.53",
	redisPort: 6379,
	redisPassword: "rmh_redis_2026",
	chunkerSize: 600,
	chunkerOverlap: 80,
	notificationEnabled: true,
	notificationWebhookUrl: "",
	companyName: "智造云",
	teamName: "销售团队",
	tenantId: "t_demo",
};

function safeParseJson(raw: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(raw) as unknown;
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}


function bool(value: unknown, fallback: boolean): boolean {
	if (value === undefined || value === null || value === "") return fallback;
	if (typeof value === "boolean") return value;
	return String(value).toLowerCase() === "true" || String(value) === "1";
}

function num(value: unknown, fallback: number): number {
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(): AppConfig {
	const file = loadConfigFile();
	const env = process.env;
	return {
		host: env.HOST ?? file.server?.host ?? defaults.host,
		port: num(env.PORT ?? file.server?.port, defaults.port),
		dataDir: env.DATA_DIR ?? file.data?.dataDir ?? defaults.dataDir,
		businessDbPath: env.BUSINESS_DB ?? defaults.businessDbPath,
		sessionDbPath: env.SESSION_DB ?? defaults.sessionDbPath,
		modelProvider: env.MODEL_PROVIDER ?? file.model?.provider ?? defaults.modelProvider,
		modelId: env.MODEL_ID ?? file.model?.modelId ?? defaults.modelId,
		modelBaseUrl: env.MODEL_BASE_URL ?? file.model?.baseUrl ?? defaults.modelBaseUrl,
		modelApiKey: env.MODEL_API_KEY ?? file.model?.apiKey ?? defaults.modelApiKey,
		modelProxy: env.MODEL_PROXY ?? file.model?.proxy ?? defaults.modelProxy,
		modelContextWindow: num(env.MODEL_CONTEXT_WINDOW ?? file.model?.contextWindow, defaults.modelContextWindow),
		modelMaxTokens: num(env.MODEL_MAX_TOKENS ?? file.model?.maxTokens, defaults.modelMaxTokens),
		modelExtraBody:
			env.MODEL_EXTRA_BODY !== undefined ? (safeParseJson(env.MODEL_EXTRA_BODY) ?? {}) : (file.model?.extraBody ?? defaults.modelExtraBody),
		knowledgeSearchLimit: num(env.KNOWLEDGE_SEARCH_LIMIT ?? file.knowledge?.searchLimit, defaults.knowledgeSearchLimit),
		mysqlEnabled: bool(env.MYSQL_ENABLED ?? file.mysql?.enabled, defaults.mysqlEnabled),
		mysqlHost: env.MYSQL_HOST ?? file.mysql?.host ?? defaults.mysqlHost,
		mysqlPort: num(env.MYSQL_PORT ?? file.mysql?.port, defaults.mysqlPort),
		mysqlUser: env.MYSQL_USER ?? file.mysql?.user ?? defaults.mysqlUser,
		mysqlPassword: env.MYSQL_PASSWORD ?? file.mysql?.password ?? defaults.mysqlPassword,
		mysqlDatabase: env.MYSQL_DATABASE ?? file.mysql?.database ?? defaults.mysqlDatabase,
		redisEnabled: bool(env.REDIS_ENABLED ?? file.redis?.enabled, defaults.redisEnabled),
		redisHost: env.REDIS_HOST ?? file.redis?.host ?? defaults.redisHost,
		redisPort: num(env.REDIS_PORT ?? file.redis?.port, defaults.redisPort),
		redisPassword: env.REDIS_PASSWORD ?? file.redis?.password ?? defaults.redisPassword,
		chunkerSize: num(env.CHUNKER_SIZE ?? file.chunker?.size, defaults.chunkerSize),
		chunkerOverlap: num(env.CHUNKER_OVERLAP ?? file.chunker?.overlap, defaults.chunkerOverlap),
		notificationEnabled: bool(env.NOTIFICATION_ENABLED ?? file.notification?.enabled, defaults.notificationEnabled),
		notificationWebhookUrl: env.NOTIFICATION_WEBHOOK_URL ?? file.notification?.webhookUrl ?? defaults.notificationWebhookUrl,
		companyName: env.COMPANY_NAME ?? file.company?.name ?? defaults.companyName,
		teamName: env.TEAM_NAME ?? file.company?.team ?? defaults.teamName,
		tenantId: env.TENANT_ID ?? file.tenant?.defaultTenantId ?? defaults.tenantId,
	};
}