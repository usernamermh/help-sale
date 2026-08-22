import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
	modelContextWindow: number;
	modelMaxTokens: number;
	modelExtraBody: Record<string, unknown>;
	knowledgeSearchLimit: number;
	chunkerSize: number;
	chunkerOverlap: number;
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
		contextWindow?: number;
		maxTokens?: number;
		/** 额外请求参数,统一放进请求体 extra_body 字段(不与其他参数平级) */
		extraBody?: Record<string, unknown>;
	};
	chunker?: { size?: number; overlap?: number };
	knowledge?: { searchLimit?: number };
	company?: { name?: string; team?: string };
}

export const CONFIG_FILE_NAME = "help-sale.config.json";

/**
 * 剥离开放 JSONC 注释(行注释 // 与块注释),字符串字面量内的内容不受影响。
 * 配置文件支持注释,便于说明每个字段的用途。
 */
export function stripJsonc(source: string): string {
	let out = "";
	let inString = false;
	let i = 0;
	while (i < source.length) {
		const ch = source[i];
		const next = source[i + 1];
		if (inString) {
			out += ch;
			if (ch === "\\") {
				out += next ?? "";
				i += 2;
				continue;
			}
			if (ch === '"') inString = false;
			i++;
			continue;
		}
		if (ch === '"') {
			inString = true;
			out += ch;
			i++;
			continue;
		}
		if (ch === "/" && next === "/") {
			while (i < source.length && source[i] !== "\n") i++;
			continue;
		}
		if (ch === "/" && next === "*") {
			i += 2;
			while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
			i += 2;
			continue;
		}
		out += ch;
		i++;
	}
	return out;
}

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
		return JSON.parse(stripJsonc(raw)) as FileConfig;
	} catch (error) {
		throw new Error(`配置文件 ${file} 解析失败(支持 JSONC 注释): ${(error as Error).message}`);
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
	modelApiKey: "local-key",
	modelContextWindow: 32768,
	modelMaxTokens: 8192,
	modelExtraBody: {},
	knowledgeSearchLimit: 5,
	chunkerSize: 600,
	chunkerOverlap: 80,
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
		modelContextWindow: num(env.MODEL_CONTEXT_WINDOW ?? file.model?.contextWindow, defaults.modelContextWindow),
		modelMaxTokens: num(env.MODEL_MAX_TOKENS ?? file.model?.maxTokens, defaults.modelMaxTokens),
		modelExtraBody:
			env.MODEL_EXTRA_BODY !== undefined ? (safeParseJson(env.MODEL_EXTRA_BODY) ?? {}) : (file.model?.extraBody ?? defaults.modelExtraBody),
		knowledgeSearchLimit: num(env.KNOWLEDGE_SEARCH_LIMIT ?? file.knowledge?.searchLimit, defaults.knowledgeSearchLimit),
		chunkerSize: num(env.CHUNKER_SIZE ?? file.chunker?.size, defaults.chunkerSize),
		chunkerOverlap: num(env.CHUNKER_OVERLAP ?? file.chunker?.overlap, defaults.chunkerOverlap),
		companyName: env.COMPANY_NAME ?? file.company?.name ?? defaults.companyName,
		teamName: env.TEAM_NAME ?? file.company?.team ?? defaults.teamName,
		tenantId: env.TENANT_ID ?? file.tenant?.defaultTenantId ?? defaults.tenantId,
	};
}