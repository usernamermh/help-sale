import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, loadConfigFile, locateConfigFile, stripJsonc } from "./env.js";

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

describe("stripJsonc", () => {
	it("剥离行注释且保留字符串内的 //", () => {
		const src = "{\n// 注释\n\"baseUrl\": \"http://x/v1\",\n\"a\": 1 // 尾部注释\n}";
		expect(JSON.parse(stripJsonc(src))).toEqual({ baseUrl: "http://x/v1", a: 1 });
	});

	it("剥离块注释", () => {
		const src = '{"a": /* 块 */ 1}';
		expect(JSON.parse(stripJsonc(src))).toEqual({ a: 1 });
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