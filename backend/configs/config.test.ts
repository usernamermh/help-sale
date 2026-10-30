import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { loadConfig, locateConfigFile } from "../env.js";

/**
 * 配置模块守卫测试。遵守两条铁律:
 *   1) 每个配置项都必须由 help-sale.config.yaml 提供,代码里没有任何默认值 —— 缺一项就报错;
 *   2) yaml 各段必须接到 configs/ 各子文件的对应字段上,不能接错。
 */
const dirs: string[] = [];
const oldConfigPath = process.env.CONFIG_PATH;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

afterEach(() => {
	vi.resetModules();
	delete process.env.SECRETS_PATH;
	if (oldConfigPath === undefined) delete process.env.CONFIG_PATH;
	else process.env.CONFIG_PATH = oldConfigPath;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 以真实配置为底改一份临时 yaml,并把它设为本次加载的 CONFIG_PATH。 */
function writeVariant(mutate: (raw: Record<string, any>) => void): void {
	const base = parse(readFileSync(locateConfigFile()!, "utf8")) as Record<string, any>;
	mutate(base);
	const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-split-"));
	dirs.push(dir);
	const file = path.join(dir, "help-sale.config.yaml");
	writeFileSync(file, stringify(base), "utf8");
	process.env.CONFIG_PATH = file;
	// 密钥与账户走独立文件:测试用仓库里的示例密钥模板,保证占位能解析
	process.env.SECRETS_PATH = path.join(repoRoot, "help-sale.secrets.example.yaml");
}

/** 重新加载 env.ts(模块顶层会重新执行 loadConfig),拿到这一份配置。 */
async function reload(): Promise<ReturnType<typeof loadConfig>> {
	vi.resetModules();
	const mod = await import("../env.js");
	return mod.config;
}

describe("配置:各段取值落到对应字段", () => {
	it("逐段改值后,config 的对应字段跟着变(段与字段没接错)", async () => {
		writeVariant((raw) => {
			raw.server.port = 4321;
			raw.server.host = "0.0.0.0";
			raw.logging.level = "debug";
			raw.logging.maxBytes = 123456;
			raw.data.mode = "local";
			raw.data.databaseId = "cmp_db";
			raw.tenant.defaultTenantId = "cmp-tenant";
			raw.model.modelId = "cmp-model";
			raw.model.maxTokens = 2048;
			raw.context = { compression: { enabled: false, thresholdRatio: 0.5, keepHead: 1, keepTail: 5, minMessages: 4, maxSummaryChars: 300 } };
			raw.knowledge.searchLimit = 7;
			raw.chunker.size = 333;
			raw.tools = { webSearch: { apiKey: "cmp-serper" }, fileWrite: { allowOutsideRepo: false }, sql: { maxRows: 50, timeoutMs: 5000, extraBlockedKeywords: ["union"] }, risk: { dangerousTools: ["terminal", "sql"], dangerousDefaultEnabled: true }, catalog: { enabled: true, threshold: 20, topK: 8, maxInspect: 3, semanticFloorZh: 0.42, semanticFloorEn: 0.6, bilingual: { enabled: true, rewriteTimeoutMs: 20000, perLanguageTopK: 8 } } };
			raw.mcp = { servers: [{ name: "cmp", url: "https://cmp.example/mcp", headers: { "X-Tenant-Id": "t9" } }] };
			raw.mysql.port = 3399;
			raw.redis.port = 6399;
			raw.notification = { enabled: true, webhookUrl: "https://cmp.example/hook" };
			raw.company = { name: "对照公司", team: "对照团队" };
			raw.userkey = "cmp-userkey";
			raw.defaults.customersLimit = 11;
			raw.subagents.maxConcurrency = 5;
			raw.automation.morningDigestTime = "06:30";
			raw.client = { workflowMineTimeoutMs: 9999 };
			raw.workflows = { mine: { days: 30, minWindow: 3, maxWindow: 6, minCount: 4, topChains: 5, refineTop: 2, dedupe: false } };
			raw.vector = { enabled: true, provider: "sqlite", baseUrl: "http://127.0.0.1:19530", database: "default", collection: "cmp_kb", token: "", dimension: 512, metricType: "COSINE", indexType: "IVF_FLAT", indexNlist: 64, searchTopK: 9, scoreThreshold: 0.5, timeoutMs: 5000, embedBatch: 32 };
		});
		const cfg = await reload();

		// server / logging
		expect(cfg.host).toBe("0.0.0.0");
		expect(cfg.port).toBe(4321);
		expect(cfg.logLevel).toBe("debug");
		expect(cfg.logMaxBytes).toBe(123456);
		// data / tenant
		expect(cfg.databaseId).toBe("cmp_db");
		expect(cfg.dataMode).toBe("local");
		expect(cfg.tenantId).toBe("cmp-tenant");
		expect(cfg.tables.customers).toBe("customers");
		// model
		expect(cfg.modelId).toBe("cmp-model");
		expect(cfg.modelMaxTokens).toBe(2048);
		// context.compression
		expect(cfg.compressionEnabled).toBe(false);
		expect(cfg.compressionKeepTail).toBe(5);
		// knowledge / chunker / tools / mcp
		expect(cfg.knowledgeSearchLimit).toBe(7);
		expect(cfg.chunkerSize).toBe(333);
			expect(cfg.webSearchApiKey).toBe("cmp-serper");
			expect(cfg.fileWriteAllowOutsideRepo).toBe(false);
			expect(cfg.sqlMaxRows).toBe(50);
			expect(cfg.sqlTimeoutMs).toBe(5000);
			expect(cfg.sqlExtraBlockedKeywords).toEqual(["union"]);
		expect(cfg.riskDangerousTools).toEqual(["terminal", "sql"]);
		expect(cfg.riskDangerousDefaultEnabled).toBe(true);
			expect(cfg.toolsCatalogEnabled).toBe(true);
			expect(cfg.toolsCatalogThreshold).toBe(20);
			expect(cfg.toolsCatalogTopK).toBe(8);
			expect(cfg.toolsCatalogMaxInspect).toBe(3);
			expect(cfg.toolsCatalogSemanticFloorZh).toBe(0.42);
			expect(cfg.toolsCatalogSemanticFloorEn).toBe(0.6);
			expect(cfg.toolsCatalogBilingualEnabled).toBe(true);
			expect(cfg.toolsCatalogRewriteTimeoutMs).toBe(20000);
			expect(cfg.toolsCatalogPerLanguageTopK).toBe(8);
		expect(cfg.mcpServers).toHaveLength(1);
		expect(cfg.mcpServers[0].headers).toEqual({ "X-Tenant-Id": "t9" });
		// 中间件
		expect(cfg.mysqlPort).toBe(3399);
		expect(cfg.redisPort).toBe(6399);
		expect(cfg.notificationEnabled).toBe(true);
		expect(cfg.notificationWebhookUrl).toBe("https://cmp.example/hook");
		// defaults / company / userkey
		expect(cfg.companyName).toBe("对照公司");
		expect(cfg.teamName).toBe("对照团队");
		expect(cfg.userKey).toBe("cmp-userkey");
		expect(cfg.customersLimit).toBe(11);
		// 多代理 / 定时任务
		expect(cfg.subagentMaxConcurrency).toBe(5);
		expect(cfg.morningDigestTime).toBe("06:30");
		// 工作流挖掘 / 向量
		expect(cfg.workflowMineDays).toBe(30);
		expect(cfg.workflowMineMaxWindow).toBe(6);
		expect(cfg.workflowMineDedupe).toBe(false);
		expect(cfg.workflowMineTimeoutMs).toBe(9999);
		expect(cfg.vectorEnabled).toBe(true);
		expect(cfg.vectorProvider).toBe("sqlite");
		expect(cfg.vectorCollection).toBe("cmp_kb");
		expect(cfg.vectorSearchTopK).toBe(9);
	});

	it("AppConfig 字段全覆盖:没有任何字段是 undefined", async () => {
		const cfg = loadConfig();
		const undefinedKeys = Object.entries(cfg).filter(([, v]) => v === undefined).map(([k]) => k);
		expect(undefinedKeys).toEqual([]);
		expect(Object.keys(cfg)).toHaveLength(130);
	});
});

describe("配置:代码内不提供任何默认值", () => {
	const cases: Array<[string, (raw: Record<string, any>) => void, RegExp]> = [
		["logging 段", (raw) => { delete raw.logging; }, /配置项 logging\.enabled/],
		["data 段", (raw) => { delete raw.data; }, /配置项 data\.mode/],
		["model 段", (raw) => { delete raw.model; }, /配置项 model\.modelId/],
		["context 段", (raw) => { delete raw.context; }, /配置项 context\.compression\.enabled/],
		["vector 段", (raw) => { delete raw.vector; }, /配置项 vector\.enabled/],
		["knowledge 段", (raw) => { delete raw.knowledge; }, /配置项 knowledge\.searchLimit/],
		["tools 段", (raw) => { delete raw.tools; }, /配置项 tools\.webSearch\.apiKey/],
		["mcp 段", (raw) => { delete raw.mcp; }, /配置项 mcp\.servers/],
		["mysql 段", (raw) => { delete raw.mysql; }, /配置项 mysql\.enabled/],
		["subagents 段", (raw) => { delete raw.subagents; }, /配置项 subagents\.maxConcurrency/],
		["automation 段", (raw) => { delete raw.automation; }, /配置项 automation\.enabled/],
		["workflows 段", (raw) => { delete raw.workflows; }, /配置项 workflows\.mine\.days/],
		["client 段", (raw) => { delete raw.client; }, /配置项 client\.workflowMineTimeoutMs/],
		["defaults 段", (raw) => { delete raw.defaults; }, /配置项 defaults\.insightsDays/],
		["company 段", (raw) => { delete raw.company; }, /配置项 company\.name/],
	];

	for (const [label, mutate, expected] of cases) {
		it(`${label}缺失:直接报错,并指出缺的配置键`, async () => {
			writeVariant(mutate);
			await expect(reload()).rejects.toThrow(expected);
		});
	}

	it("整段字段留空(如 logging.level: )同样报错,不会被当成默认值", async () => {
		writeVariant((raw) => {
			raw.logging.level = null;
		});
		await expect(reload()).rejects.toThrow(/配置项 logging\.level/);
	});

	it("空数组 / 空字符串是显式取值,允许通过(不等于缺省)", async () => {
		writeVariant((raw) => {
			raw.mcp = { servers: [] };
			raw.subagents.defaultTools = [];
			raw.model.proxy = "";
			raw.notification.webhookUrl = "";
		});
		const cfg = await reload();
		expect(cfg.mcpServers).toEqual([]);
		expect(cfg.subagentDefaultTools).toEqual([]);
		expect(cfg.modelProxy).toBe("");
	});

	it("配置文件不存在:直接报错", async () => {
		process.env.CONFIG_PATH = path.join(os.tmpdir(), "not-exist-config.yaml");
		await expect(reload()).rejects.toThrow(/无法读取配置文件/);
	});

	it("配置文件为空:直接报错", async () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-empty-"));
		dirs.push(dir);
		const file = path.join(dir, "help-sale.config.yaml");
		writeFileSync(file, "# 只有注释,没有配置\n", "utf8");
		process.env.CONFIG_PATH = file;
		await expect(reload()).rejects.toThrow(/是空的/);
	});

	it("示例模板 help-sale.config.example.yaml 覆盖全部必填项", async () => {
		process.env.CONFIG_PATH = path.join(repoRoot, "help-sale.config.example.yaml");
		process.env.SECRETS_PATH = path.join(repoRoot, "help-sale.secrets.example.yaml");
		const cfg = await reload();
		expect(Object.keys(cfg)).toHaveLength(130);
	});
});
