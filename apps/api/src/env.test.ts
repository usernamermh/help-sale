import { describe, expect, it } from "vitest";
import { loadConfig, loadConfigFile, locateConfigFile } from "./env.js";

// 配置唯一来源:help-sale.config.yaml。环境变量一律不参与配置读取(仅 CONFIG_PATH 可选配置文件路径)。
const YAML = {
	modelId: loadConfig().modelId, // 以 yaml 实际值为基准
	port: loadConfig().port,
	modelProxy: loadConfig().modelProxy,
	dataDir: loadConfig().dataDir,
	logEnabled: loadConfig().logEnabled,
	logDir: loadConfig().logDir,
};

describe("config", () => {
	it("定位到仓库顶层 YAML 配置文件", () => {
		const file = locateConfigFile();
		expect(file).toBeDefined();
		expect(file!.endsWith("help-sale.config.yaml")).toBe(true);
	});

	it("读取顶层配置关键值", () => {
		const cfg = loadConfig();
		expect(cfg.modelProvider).toBe("local-llm");
		expect(cfg.modelBaseUrl.startsWith("http")).toBe(true);
		// baseUrl 不含 /chat/completions:openai 兼容客户端会自动拼路径
		expect(cfg.modelBaseUrl.endsWith("/chat/completions")).toBe(false);
		expect(cfg.knowledgeSearchLimit).toBeGreaterThan(0);
		expect(typeof cfg.modelProxy).toBe("string");
		expect(cfg.chunkerSize).toBeGreaterThan(0);
		expect(cfg.chunkerOverlap).toBeLessThan(cfg.chunkerSize);
		expect(cfg.dataMode).toBe("local");
	});

	it("YAML 配置含注释仍可解析", () => {
		const file = loadConfigFile();
		expect(typeof file.server?.port).toBe("number");
		expect(file.server!.port).toBeGreaterThan(0);
		expect(file.model?.baseUrl).toBeTruthy();
		expect(file.company?.name).toBeTruthy();
		expect(file.model?.extraBody).toEqual({});
	});

	it("环境变量不覆盖配置:modelId/port/proxy/dataDir 均取 yaml 值", () => {
		const old1 = process.env.MODEL_ID;
		const old2 = process.env.PORT;
		const old3 = process.env.MODEL_PROXY;
		const old4 = process.env.DATA_DIR;
		process.env.MODEL_ID = "override-model";
		process.env.PORT = "4321";
		process.env.MODEL_PROXY = "http://127.0.0.1:8123";
		process.env.DATA_DIR = "/tmp/custom-data";
		try {
			const cfg = loadConfig();
			expect(cfg.modelId).toBe(YAML.modelId);
			expect(cfg.port).toBe(YAML.port);
			expect(cfg.modelProxy).toBe(YAML.modelProxy);
			expect(cfg.dataDir).toBe(YAML.dataDir);
		} finally {
			if (old1 === undefined) delete process.env.MODEL_ID; else process.env.MODEL_ID = old1;
			if (old2 === undefined) delete process.env.PORT; else process.env.PORT = old2;
			if (old3 === undefined) delete process.env.MODEL_PROXY; else process.env.MODEL_PROXY = old3;
			if (old4 === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = old4;
		}
	});

	it("环境变量不覆盖配置:日志目录/开关/extraBody/data.mode 均取 yaml 值", () => {
		const old1 = process.env.LOG_DIR;
		const old2 = process.env.LOG_ENABLED;
		const old3 = process.env.MODEL_EXTRA_BODY;
		const old4 = process.env.DATA_MODE;
		process.env.LOG_DIR = "/tmp/repo-log";
		process.env.LOG_ENABLED = "false";
		process.env.MODEL_EXTRA_BODY = '{"temperature":0.7}';
		process.env.DATA_MODE = "mysql";
		try {
			const cfg = loadConfig();
			expect(cfg.logDir).toBe(YAML.logDir);
			expect(cfg.logEnabled).toBe(YAML.logEnabled);
			expect(cfg.modelExtraBody).toEqual({});
			expect(cfg.dataMode).toBe("local");
		} finally {
			if (old1 === undefined) delete process.env.LOG_DIR; else process.env.LOG_DIR = old1;
			if (old2 === undefined) delete process.env.LOG_ENABLED; else process.env.LOG_ENABLED = old2;
			if (old3 === undefined) delete process.env.MODEL_EXTRA_BODY; else process.env.MODEL_EXTRA_BODY = old3;
			if (old4 === undefined) delete process.env.DATA_MODE; else process.env.DATA_MODE = old4;
		}
	});

	it("数据存储元信息:databaseId 与 tables 表名映射来自配置", () => {
		const cfg = loadConfig();
		expect(cfg.databaseId).toBe("help_sale");
		expect(cfg.tables.customers).toBe("customers");
		expect(cfg.tables.stores).toBe("stores");
		expect(cfg.tables.digests).toBe("digests");
		expect(Object.keys(cfg.tables).length).toBeGreaterThanOrEqual(10);
	});
});