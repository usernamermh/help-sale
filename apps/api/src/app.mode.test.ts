import { afterEach, describe, expect, it } from "vitest";

// 注:config 是模块级实例,单个测试进程只能验证一种数据模式;
// local 模式由 app.test 等全量用例覆盖,这里只验证 mysql 模式的 fail-fast。
describe("data.mode 存储模式", () => {
	const old = process.env.DATA_MODE;
	afterEach(() => {
		if (old === undefined) delete process.env.DATA_MODE;
		else process.env.DATA_MODE = old;
	});

	it("mysql 主库模式未迁移时启动即报错,避免两套存储并用", async () => {
		process.env.DATA_MODE = "mysql";
		const { buildApp } = await import("./app.js");
		expect(() => buildApp({ dataDir: ".tmp/mode-test" })).toThrow(/data\.mode=mysql/);
	});
});