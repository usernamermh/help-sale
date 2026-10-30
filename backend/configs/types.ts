/**
 * 配置类型:AppConfig 是对外(env.ts)暴露的完整配置契约,与拆分前逐字段一致;
 * 下面按配置段派生的 *Config 是各子文件 load 函数的返回值契约,全部由 Pick<AppConfig> 派生,
 * 因此「某段少返回一个字段」或「多返回一个不存在的字段」都会在编译期暴露。
 */
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
	/** 运行日志级别(info 或 error),低于该级别(仅 error)的日志不落盘 */
	logLevel: "debug" | "info" | "error";
	/** 运行日志文件名(位于 logging.dir 下),默认 runtime.log */
	logRuntimeFile: string;
	// 上下文压缩(context 段)
	compressionEnabled: boolean;
	compressionThresholdRatio: number; // 触发压缩的上下文占用比例(0-1)
	compressionKeepHead: number; // 始终保留的开头消息条数
	compressionKeepTail: number; // 始终保留的最近消息条数
	compressionMinMessages: number; // 少于该条数不压缩
	compressionMaxSummaryChars: number; // 摘要最大字符数
	webSearchApiKey: string;
	/** 文件写入工具是否允许写到仓库之外(tools.fileWrite.allowOutsideRepo) */
	fileWriteAllowOutsideRepo: boolean;
	/** SQL 工具单次最多返回行数(tools.sql.maxRows) */
	sqlMaxRows: number;
	/** SQL 单条执行超时(tools.sql.timeoutMs) */
	sqlTimeoutMs: number;
	/** SQL 追加拦截的关键字(tools.sql.extraBlockedKeywords) */
	sqlExtraBlockedKeywords: string[]; // web_search 工具(Serper API)密钥
	mcpServers: Array<{ name: string; url: string; headers?: Record<string, string>; pat?: string }>; // 外部 MCP Server 列表(MCP 客户端接入)
	// 微信通道(weixin 段,iLink 机器人)
	weixinEnabled: boolean;
	weixinBaseUrl: string;
	weixinAccountId: string;
	weixinToken: string;
	weixinTenantId: string;
	weixinBotType: string;
	weixinMaxMessageLength: number;
	weixinSendRetries: number;
	weixinSendRetryDelayMs: number;
	weixinPollTimeoutMs: number;
	weixinDedupTtlSeconds: number;
	weixinAgentTimeoutMs: number;
	weixinAutoReply: boolean;
	weixinUnsupportedText: string;
	weixinAllowFrom: string[];
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
	// 自动任务(晨报/周报/沉默唤醒)
	// 子代理/多代理(subagents 段)
	subagentMaxConcurrency: number;
	subagentPollIntervalMs: number;
	subagentTimeoutMs: number;
	subagentDefaultTools: string[];
	automationEnabled: boolean;
	morningDigestTime: string;
	weeklyReportWeekday: number;
	weeklyReportTime: string;
	silentCustomerDays: number;
	silentWakeupEnabled: boolean;
	wakeupTaskTime: string;
	userKey: string;
	// 工作流挖掘(workflows.mine 段):历史窗口 / 子序列窗口 / 频次阈值 / 候选与提炼上限
	workflowMineDays: number;
	workflowMineMinWindow: number;
	workflowMineMaxWindow: number;
	workflowMineMinCount: number;
	workflowMineTopChains: number;
	workflowMineRefineTop: number;
	workflowMineTimeoutMs: number;
	/** 挖掘时是否跳过已存在(含已驳回)的同签名工作流 */
	workflowMineDedupe: boolean;
	// 向量检索(vector 段):provider=milvus 时走向量库,sqlite 时走本地兜底
	/** 工具编目(tools.catalog 段):长尾工具超过阈值时改为 search_tools → get_tool_details → call_tool 按需加载 */
	toolsCatalogEnabled: boolean;
	toolsCatalogThreshold: number;
	toolsCatalogTopK: number;
	toolsCatalogMaxInspect: number;
	/** 语义通道相似度下限(0-1):中文候选池(BGE 对同语种打分天然更高,中英必须分开配) */
	toolsCatalogSemanticFloorZh: number;
	/** 语义通道相似度下限(0-1):英文候选池 */
	toolsCatalogSemanticFloorEn: number;
	/** 双语召回:是否把用户问题改写成 {"zh","en"} 两条 query 分别召回 */
	toolsCatalogBilingualEnabled: boolean;
	/** query 改写的超时(毫秒) */
	toolsCatalogRewriteTimeoutMs: number;
	/** 每种语言各自召回多少条进融合 */
	toolsCatalogPerLanguageTopK: number;
	vectorEnabled: boolean;
	vectorProvider: "sqlite" | "milvus";
	vectorBaseUrl: string;
	vectorDatabase: string;
	vectorCollection: string;
	vectorToken: string;
	vectorDimension: number;
	vectorMetric: string;
	vectorIndexType: string;
	vectorIndexNlist: number;
	vectorSearchTopK: number;
	vectorScoreThreshold: number;
	vectorTimeoutMs: number;
	vectorEmbedBatch: number;
	/** Milvus 服务端配置覆盖(落成 user.yaml),结构由配置文件决定 */
	milvusBackend: Record<string, unknown>;
	/** Milvus standalone + etcd 的 compose 定义(落成 docker-compose.yml),结构由配置文件决定 */
	milvusDockerCompose: Record<string, unknown>;
}

/** server + logging 段:监听地址与运行日志。 */
export type RuntimeConfig = Pick<AppConfig, "host" | "port" | "logEnabled" | "logDir" | "logMaxBytes" | "logLevel" | "logRuntimeFile">;
/** data + tenant 段:存储模式、表名映射、路径与默认租户。 */
export type DataConfig = Pick<AppConfig, "dataMode" | "databaseId" | "tables" | "dataDir" | "memoryFile" | "businessDbPath" | "sessionDbPath" | "tenantId">;
/** model 段:模型端点、密钥、上下文窗口与额外请求体。 */
export type ModelConfig = Pick<AppConfig, "modelId" | "modelBaseUrl" | "modelApiKey" | "modelProxy" | "modelContextWindow" | "modelMaxTokens" | "modelExtraBody">;
/** context.compression 段:长对话记忆压缩参数。 */
export type ContextConfig = Pick<AppConfig, "compressionEnabled" | "compressionThresholdRatio" | "compressionKeepHead" | "compressionKeepTail" | "compressionMinMessages" | "compressionMaxSummaryChars">;
/** knowledge + chunker + vector 段:检索条数、分块参数与向量后端。 */
export type RetrievalConfig = Pick<AppConfig,
	| "knowledgeSearchLimit" | "chunkerSize" | "chunkerOverlap"
	| "vectorEnabled" | "vectorProvider" | "vectorBaseUrl" | "vectorDatabase" | "vectorCollection" | "vectorToken"
	| "vectorDimension" | "vectorMetric" | "vectorIndexType" | "vectorIndexNlist"
	| "vectorSearchTopK" | "vectorScoreThreshold" | "vectorTimeoutMs" | "vectorEmbedBatch">;
/** mysql + redis + notification + tools + mcp 段:中间件与外部工具接入。 */
export type IntegrationsConfig = Pick<AppConfig,
	| "mysqlEnabled" | "mysqlSchemaRebuild" | "mysqlConnectTimeout" | "mysqlHost" | "mysqlPort" | "mysqlUser" | "mysqlPassword" | "mysqlDatabase"
	| "redisEnabled" | "redisHost" | "redisPort" | "redisPassword"
	| "notificationEnabled" | "notificationWebhookUrl"
	| "webSearchApiKey" | "fileWriteAllowOutsideRepo" | "sqlMaxRows" | "sqlTimeoutMs" | "sqlExtraBlockedKeywords" | "mcpServers"
	| "toolsCatalogEnabled" | "toolsCatalogThreshold" | "toolsCatalogTopK" | "toolsCatalogMaxInspect" | "toolsCatalogSemanticFloorZh" | "toolsCatalogSemanticFloorEn"
	| "toolsCatalogBilingualEnabled" | "toolsCatalogRewriteTimeoutMs" | "toolsCatalogPerLanguageTopK">;
/** defaults + company + userkey 段:业务默认条数、公司与调用方标识。 */
export type DefaultsConfig = Pick<AppConfig,
	| "companyName" | "teamName" | "userKey"
	| "insightsDays" | "improvementsDays" | "conversationsLimit" | "dealsLimit" | "storeOverviewDays" | "customersLimit"
	| "knowledgeCandidatesLimit" | "agentThreadsLimit" | "transcriptLimit" | "agentListLimit"
	| "notificationScanLimit" | "remindersTakeLimit">;
/** subagents + automation + workflows.mine + client 段:多代理、定时任务与工作流挖掘。 */
export type FeaturesConfig = Pick<AppConfig,
	| "subagentMaxConcurrency" | "subagentPollIntervalMs" | "subagentTimeoutMs" | "subagentDefaultTools"
	| "automationEnabled" | "morningDigestTime" | "weeklyReportWeekday" | "weeklyReportTime"
	| "silentCustomerDays" | "silentWakeupEnabled" | "wakeupTaskTime"
	| "workflowMineDays" | "workflowMineMinWindow" | "workflowMineMaxWindow" | "workflowMineMinCount"
	| "workflowMineTopChains" | "workflowMineRefineTop" | "workflowMineTimeoutMs" | "workflowMineDedupe">;
/** weixin 段:微信 iLink 机器人通道(登录凭据、租户、分片、去重与超时)。 */
export type WeixinConfig = Pick<AppConfig,
	| "weixinEnabled" | "weixinBaseUrl" | "weixinAccountId" | "weixinToken" | "weixinTenantId" | "weixinBotType"
	| "weixinMaxMessageLength" | "weixinSendRetries" | "weixinSendRetryDelayMs" | "weixinPollTimeoutMs"
	| "weixinDedupTtlSeconds" | "weixinAgentTimeoutMs" | "weixinAutoReply" | "weixinUnsupportedText" | "weixinAllowFrom">;
/** milvus_backend + milvus_docker_compose 段:Milvus 部署清单(整体透出,不做字段级校验) */
export type MilvusDeployConfig = Pick<AppConfig, "milvusBackend" | "milvusDockerCompose">;
