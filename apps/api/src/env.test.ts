import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, loadConfigFile, locateConfigFile } from "./env.js";

describe("config", () => {
	it("定位到仓库顶层配置文件", () => {
		const file = locateConfigFile();
		expect(file).toBeDefined();
		expect(file!.endsWith("help-sale.config.json")).toBe(true);
	});

	it("读取顶层配置的默认值", () => {
		const cfg = loadConfig();
		expect(cfg.modelProvider).toBe("local-llm");
		expect(cfg.modelId).toBe("u21-preview");
		expect(cfg.modelBaseUrl).toContain("10.252.60.39");
		expect(cfg.knowledgeSearchLimit).toBeGreaterThan(0);
		expect(cfg.chunkerSize).toBeGreaterThan(0);
		expect(cfg.chunkerOverlap).toBeLessThan(cfg.chunkerSize);
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

	it("配置文件结构完整", () => {
		const file = loadConfigFile();
		expect(file.server?.port).toBe(3000);
		expect(file.model?.baseUrl).toBeTruthy();
		expect(file.company?.name).toBeTruthy();
	});
});