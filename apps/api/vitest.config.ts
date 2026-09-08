import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["src/**/*.test.ts"],
		pool: "forks",
		hookTimeout: 30_000,
		testTimeout: 30_000,
	},
});