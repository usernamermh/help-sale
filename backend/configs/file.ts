import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { loadSecretsDocument, mergeSecrets, resolvePlaceholders } from "./secrets.js";

// 所有运行配置只从 help-sale.config.yaml 读取,不允许环境变量覆盖。
// 唯一例外:CONFIG_PATH 仅用于指定配置文件路径(不是配置项本身)。

/**
 * help-sale.config.yaml 的原始结构。
 *
 * 这里字段写成可选,只是表示"从 yaml 解析出来的对象里什么都可能没有"(文件没写、值为 null),
 * **不代表代码允许缺省**:每个字段的必填校验在各配置段里通过 primitives 完成,缺了就报错。
 */
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
	tenant?: { defaultTenantId?: string; headerTenantAllowed?: boolean; trustedTenantIds?: string[]; dataIsolationMode?: string; apiKeys?: Record<string, string> };
	model?: {
		modelId?: string;
		baseUrl?: string;
		apiKey?: string;
		proxy?: string;
		contextWindow?: number;
		maxTokens?: number;
		extraBody?: Record<string, unknown>;
	};
	context?: {
		compression?: {
			enabled?: boolean;
		thresholdRatio?: number;
		keepHead?: number;
		keepTail?: number;
		minMessages?: number;
		maxSummaryChars?: number;
	};
	};
	chunker?: { size?: number; overlap?: number };
	tools?: {
		webSearch?: { apiKey?: string };
		/** 文件写入工具:是否允许写到仓库目录之外 */
		fileWrite?: { allowOutsideRepo?: boolean };
		/** SQL 工具:返回行数上限、执行超时、追加拦截的关键字 */
		sql?: { maxRows?: number; timeoutMs?: number; extraBlockedKeywords?: string[] };
		risk?: { dangerousTools?: string[]; dangerousDefaultEnabled?: boolean };
		/** 工具编目:长尾工具(MCP/工作流)超过阈值时改为按需检索 */
		catalog?: { enabled?: boolean; threshold?: number; topK?: number; maxInspect?: number; semanticFloorZh?: number; semanticFloorEn?: number; bilingual?: { enabled?: boolean; rewriteTimeoutMs?: number; perLanguageTopK?: number } };
	};
	mcp?: {
		servers?: Array<{ name: string; url: string; headers?: Record<string, string>; pat?: string }>;
	};
	knowledge?: { searchLimit?: number };
	logging?: { enabled?: boolean; dir?: string; maxBytes?: number; level?: "debug" | "info" | "error"; runtimeFile?: string };
	mysql?: { enabled?: boolean; schemaRebuild?: boolean; connectTimeout?: number; host?: string; port?: number; user?: string; password?: string; database?: string };
	redis?: { enabled?: boolean; host?: string; port?: number; password?: string };
	notification?: { enabled?: boolean; webhookUrl?: string };
	company?: { name?: string; team?: string };
	client?: { workflowMineTimeoutMs?: number };
	/** 工作流挖掘参数(全部可选,缺省用代码内默认值,便于向后兼容旧配置文件) */
	workflows?: {
		mine?: {
			days?: number;
			minWindow?: number;
			maxWindow?: number;
			minCount?: number;
			topChains?: number;
			refineTop?: number;
			dedupe?: boolean;
		};
	};
	/** 向量检索(Milvus 可选旁路;enabled=false 时全部走本地 SQLite/降级向量) */
	vector?: {
		enabled?: boolean;
		provider?: "sqlite" | "milvus";
		baseUrl?: string;
		database?: string;
		collection?: string;
		token?: string;
		dimension?: number;
		metricType?: string;
		indexType?: string;
		indexNlist?: number;
		searchTopK?: number;
		scoreThreshold?: number;
		timeoutMs?: number;
		embedBatch?: number;
	};
	/** Milvus 服务端配置覆盖(落成 user.yaml) */
	milvus_backend?: Record<string, unknown>;
	/** Milvus standalone + etcd 的 compose 定义(落成 docker-compose.yml) */
	milvus_docker_compose?: Record<string, unknown>;
	automation?: {
		enabled?: boolean;
		morningDigestTime?: string;
		weeklyReportWeekday?: number;
		weeklyReportTime?: string;
		silentCustomerDays?: number;
		silentWakeupEnabled?: boolean;
		wakeupTaskTime?: string;
	};
	subagents?: {
		maxConcurrency?: number;
		pollIntervalMs?: number;
		timeoutMs?: number;
		defaultTools?: string[];
	};
	/** 微信通道(iLink 机器人):登录凭据、租户、分片与超时 */
	weixin?: {
		enabled?: boolean;
		baseUrl?: string;
		accountId?: string;
		token?: string;
		tenantId?: string;
		botType?: string;
		maxMessageLength?: number;
		sendRetries?: number;
		sendRetryDelayMs?: number;
		pollTimeoutMs?: number;
		dedupTtlSeconds?: number;
		agentTimeoutMs?: number;
		autoReply?: boolean;
		ackText?: string;
		unsupportedText?: string;
		commandsEnabled?: boolean;
		sessionsLimit?: number;
		allowFrom?: string[];
	};
	userkey?: string;
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
	};
}

/** 定位配置文件:CONFIG_PATH 优先,否则取仓库顶层的 help-sale.config.yaml(不存在返回 undefined)。 */
export function locateConfigFile(): string | undefined {
	const override = process.env.CONFIG_PATH;
	if (override) return override;
	// 本文件位于 backend/configs/file.ts,向上两级即仓库顶层
	const here = path.dirname(fileURLToPath(import.meta.url));
	const candidate = path.resolve(here, "..", "..", "help-sale.config.yaml");
	return existsSync(candidate) ? candidate : undefined;
}

/**
 * 读取并解析 YAML。配置文件不存在 / 内容为空 / 顶层不是键值映射,一律直接报错 ——
 * 代码里没有任何默认值,缺少配置文件就没有可用的配置。
 */
export function loadConfigFile(): FileConfig {
	const file = locateConfigFile();
	if (!file) {
		throw new Error("未找到配置文件:请在仓库顶层放置 help-sale.config.yaml(或用 CONFIG_PATH 指定路径);所有参数都必须由配置文件提供");
	}
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch (error) {
		throw new Error(`无法读取配置文件 ${file}: ${(error as Error).message}`);
	}
	let parsed: unknown;
	try {
		parsed = parseYaml(raw);
	} catch (error) {
		throw new Error(`配置文件 ${file} 不是合法 YAML: ${(error as Error).message}`);
	}
	if (parsed === null || parsed === undefined) {
		throw new Error(`配置文件 ${file} 是空的:所有参数都必须由配置文件提供,代码内不提供默认值`);
	}
	if (typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`配置文件 ${file} 顶层必须是键值映射(yaml mapping)`);
	}
	// 账户与密钥:先由密钥文件补缺,再统一解析 ${ENV:...} / ${SECRETS:...} 占位
	const secrets = loadSecretsDocument(file);
	const root = parsed as Record<string, unknown>;
	const { plaintextKeys } = mergeSecrets(root, secrets);
	const resolved = resolvePlaceholders(root, secrets) as Record<string, unknown>;
	if (plaintextKeys.length > 0) {
		console.warn(
			`[config] 以下账户/密钥仍直接写在主配置里:${plaintextKeys.join(", ")}。` +
				`建议迁到 ${secrets.source ?? path.join(path.dirname(file), "help-sale.secrets.yaml")},` +
				`或写成 \${ENV:变量名} 由部署环境注入。`,
		);
	}
	return resolved as FileConfig;
}
