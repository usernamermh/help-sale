import { describe, expect, it } from "vitest";
import { createModelRegistry, resolveModel } from "./models.js";

describe("model registry", () => {
	it("deepseek 目录可解析内置模型", () => {
		process.env.DEEPSEEK_API_KEY = "sk-dummy";
		const model = resolveModel({ modelProvider: "deepseek", modelId: "deepseek-chat" });
		expect(model).toBeDefined();
		expect(model!.provider).toBe("deepseek");
	});

	it("未知模型返回 undefined", () => {
		const model = createModelRegistry().models.getModel("deepseek", "no-such-model");
		expect(model).toBeUndefined();
	});
});