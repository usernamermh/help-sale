import { describe, expect, it } from "vitest";
import { loadConfig, loadConfigFile, locateConfigFile } from "./env.js";

describe("config", () => {
	it("定位到仓库顶层 YAML 配置文件", () => {
		const file = locateConfigFile();
		expect(file).toBeDefined();
		expect(file!.endsWith("help-sale.config.yaml")).toBe(true);
	});

	it("读取顶层配置的默认值", () => {
		const cfg = loadConfig();
		expect(cfg.modelProvider).toBe("local-llm");
		expect(cfg.modelId.length).toBeGreaterThan(0);
		expect(cfg.modelBaseUrl.startsWith("http")).toBe(true);
		// baseUrl 不含 /chat/completions:openai 兼容客户端会自动拼路径
		expect(cfg.modelBaseUrl.endsWith("/chat/completions")).toBe(false);
		expect(cfg.knowledgeSearchLimit).toBeGreaterThan(0);
		expect(typeof cfg.modelProxy).toBe("string");
		expect(cfg.chunkerSize).toBeGreaterThan(0);
		expect(cfg.chunkerOverlap).toBeLessThan(cfg.chunkerSize);
	});

	it("YAML 配置含注释仍可解析", () => {
		const file = loadConfigFile();
		expect(typeof file.server?.port).toBe("number");
		expect(file.server!.port).toBeGreaterThan(0);
		expect(file.model?.baseUrl).toBeTruthy();
		expect(file.company?.name).toBeTruthy();
		expect(file.model?.extraBody).toEqual({});
	});

	it("环境变量覆盖配置文件", () => {
		const oldModel = process.env.MODEL_ID;
		const oldPort = process.env.PORT;
		process.env.MODEL_ID = "override-model";
		process.env.PORT = "4321";
		try {
			const cfg = loadConfig();
			expect(cfg.modelId).toBe("override-model");
			expect(cfg.port).toBe(4321);
		} finally {
			if (oldModel === undefined) delete process.env.MODEL_ID;
			else process.env.MODEL_ID = oldModel;
			if (oldPort === undefined) delete process.env.PORT;
			else process.env.PORT = oldPort;
		}
	});


	it("MODEL_PROXY 环境变量覆盖", () => {
		const old = process.env.MODEL_PROXY;
		process.env.MODEL_PROXY = "http://127.0.0.1:8123";
		try {
			expect(loadConfig().modelProxy).toBe("http://127.0.0.1:8123");
		} finally {
			if (old === undefined) delete process.env.MODEL_PROXY;
			else process.env.MODEL_PROXY = old;
		}
	});
		it("路径配置可被环境变量覆盖", () => {
		const old = process.env.DATA_DIR;
		process.env.DATA_DIR = "/tmp/custom-data";
		try {
			expect(loadConfig().dataDir).toBe("/tmp/custom-data");
		} finally {
			if (old === undefined) delete process.env.DATA_DIR;
			else process.env.DATA_DIR = old;
		}
	});
});

describe("extra body", () => {
	it("环境变量 MODEL_EXTRA_BODY 以 JSON 覆盖", () => {
		const old = process.env.MODEL_EXTRA_BODY;
		process.env.MODEL_EXTRA_BODY = '{"temperature":0.7}';
		try {
			expect(loadConfig().modelExtraBody).toEqual({ temperature: 0.7 });
		} finally {
			if (old === undefined) delete process.env.MODEL_EXTRA_BODY;
			else process.env.MODEL_EXTRA_BODY = old;
		}
	});


	it("日志配置:默认启用并指向 log 目录", () => {
		delete process.env.LOG_DIR;
		delete process.env.LOG_ENABLED;
		const cfg = loadConfig();
		expect(cfg.logEnabled).toBe(true);
		expect(cfg.logDir.toLowerCase()).toContain("log");
		expect(cfg.logMaxBytes).toBeGreaterThan(0);
	});

	it("日志配置:环境变量可覆盖目录与开关", () => {
		const oldD = process.env.LOG_DIR;
		const oldE = process.env.LOG_ENABLED;
		process.env.LOG_DIR = "/tmp/repo-log";
		process.env.LOG_ENABLED = "false";
		try {
			const cfg = loadConfig();
			expect(cfg.logDir).toBe("/tmp/repo-log");
			expect(cfg.logEnabled).toBe(false);
		} finally {
			if (oldD === undefined) delete process.env.LOG_DIR; else process.env.LOG_DIR = oldD;
			if (oldE === undefined) delete process.env.LOG_ENABLED; else process.env.LOG_ENABLED = oldE;
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