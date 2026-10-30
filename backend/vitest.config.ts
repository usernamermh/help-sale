import { defineConfig } from "vitest/config";

// backend/ 是扁平布局(db/、integrations/ 直接放代码),所以测试包含整个目录而不是 src/
export default defineConfig({
	test: {
		environment: "node",
		// 3party/ 与 front/ 与 backend 平级:测试就放在模块/资源旁边一起跑
		include: ["**/*.test.ts", "../3party/**/*.test.ts", "../front/**/*.test.ts"],
		exclude: ["node_modules/**"],
		pool: "forks",
		hookTimeout: 30_000,
		testTimeout: 30_000,
	},
});
