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
		expect(cfg.modelId).toBe("deepseek-v4-pro-0813");
		expect(cfg.modelBaseUrl).toContain("10.10.20.34");
		expect(cfg.knowledgeSearchLimit).toBeGreaterThan(0);
		expect(cfg.modelProxy).toBeTruthy();
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
});