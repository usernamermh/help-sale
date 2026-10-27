import { describe, expect, it } from "vitest";
import { LOCAL_PROVIDER_ID, createModelRegistry, injectExtraBody, resolveModel } from "./models.js";

describe("model registry", () => {
	it("固定解析配置里的本地模型", () => {
		const model = resolveModel();
		expect(model).toBeDefined();
		expect(model!.provider).toBe(LOCAL_PROVIDER_ID);
	});

	it("未知模型返回 undefined", () => {
		const model = createModelRegistry().models.getModel(LOCAL_PROVIDER_ID, "no-such-model");
		expect(model).toBeUndefined();
	});
});

describe("injectExtraBody", () => {
	it("额外参数统一进 extra_body 字段,不与其他参数平级", () => {
		const body = JSON.stringify({ model: "u21-preview", messages: [{ role: "user", content: "hi" }], stream: true });
		const next = JSON.parse(injectExtraBody(body, { temperature: 0.7, top_p: 0.9 })) as Record<string, unknown>;
		expect(next.model).toBe("u21-preview");
		expect(next.temperature).toBeUndefined();
		expect(next.extra_body).toEqual({ temperature: 0.7, top_p: 0.9 });
	});

	it("已有 extra_body 时合并且后者覆盖", () => {
		const body = JSON.stringify({ model: "m", extra_body: { temperature: 0.5 } });
		const next = JSON.parse(injectExtraBody(body, { temperature: 0.7 })) as { extra_body: Record<string, unknown> };
		expect(next.extra_body).toEqual({ temperature: 0.7 });
	});

	it("非 JSON body 原样返回", () => {
		expect(injectExtraBody("not json", { a: 1 })).toBe("not json");
	});
});