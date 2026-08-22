import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

describe("health", () => {
	it("GET /api/v1/health 返回 ok", async () => {
		const app = buildApp();
		const res = await app.inject({ method: "GET", url: "/api/v1/health" });
		expect(res.statusCode).toBe(200);
		expect(res.json().status).toBe("ok");
		await app.close();
	});
});