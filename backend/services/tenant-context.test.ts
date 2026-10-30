import { describe, expect, it } from "vitest";
import { extractApiKey, resolveTenant } from "./tenant-context.js";

const base = {
	apiKeys: { "key-a": "t_a", "key-b": "t_b" },
	headerAllowed: true,
	trustedTenantIds: [] as string[],
	defaultTenantId: "t_default",
};

describe("租户上下文解析", () => {
	it("API Key 权威决定租户,请求头不能覆盖", () => {
		expect(resolveTenant({ ...base, headers: { authorization: "Bearer key-a" } })).toEqual({ tenantId: "t_a", source: "api-key" });
		expect(resolveTenant({ ...base, headers: { "x-api-key": "key-b", "x-tenant-id": "t_b" } }).tenantId).toBe("t_b");
		const mismatch = resolveTenant({ ...base, headers: { "x-api-key": "key-a", "x-tenant-id": "t_b" } });
		expect(mismatch.error?.status).toBe(403);
	});

	it("无效 API Key 直接 401,不回落请求头", () => {
		expect(resolveTenant({ ...base, headers: { authorization: "Bearer nope", "x-tenant-id": "t_a" } }).error?.status).toBe(401);
	});

	it("不允许请求头声明租户时:没凭证就 401", () => {
		expect(resolveTenant({ ...base, headerAllowed: false, headers: { "x-tenant-id": "t_a" } }).error?.status).toBe(401);
		expect(resolveTenant({ ...base, headerAllowed: false, headers: {} }).error?.status).toBe(401);
		expect(resolveTenant({ ...base, headerAllowed: false, headers: { authorization: "Bearer key-a" } }).tenantId).toBe("t_a");
	});

	it("受信清单之外的租户被拒", () => {
		const trusted = { ...base, trustedTenantIds: ["t_a"] };
		expect(resolveTenant({ ...trusted, headers: { "x-tenant-id": "t_other" } }).error?.status).toBe(403);
		expect(resolveTenant({ ...trusted, headers: { "x-tenant-id": "t_a" } }).tenantId).toBe("t_a");
	});

	it("都没有时落到默认租户", () => {
		expect(resolveTenant({ ...base, headers: {} })).toEqual({ tenantId: "t_default", source: "default" });
	});

	it("从两种头里都能取出凭证", () => {
		expect(extractApiKey({ authorization: "bearer abc" })).toBe("abc");
		expect(extractApiKey({ "x-api-key": " xyz " })).toBe("xyz");
		expect(extractApiKey({})).toBe("");
	});
});