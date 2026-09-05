import { afterEach, describe, expect, it } from "vitest";

// 注:config 是模块级实例,单个测试进程只能验证一种数据模式;
// local 模式由 app.test 等全量用例覆盖,这里验证 mysql 模式连接失败时的可读报错。
process.env.MYSQL_CONNECT_TIMEOUT = "1500";
describe("data.mode 存储模式", () => {
	const old = process.env.DATA_MODE;
	afterEach(() => {
		if (old === undefined) delete process.env.DATA_MODE;
		else process.env.DATA_MODE = old;
	});

	it("mysql 模式连接不可用/初始化失败时启动报出可读错误", async () => {
		process.env.DATA_MODE = "mysql";
		const { buildApp } = await import("./app.js");
		expect(() => buildApp({ dataDir: ".tmp/mode-test", seedVehiclesFor: false })).toThrow(/^mysql/);
	});
});