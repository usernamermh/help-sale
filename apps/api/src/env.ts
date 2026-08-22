export function loadEnv(): void {
	if (typeof process.loadEnvFile === "function") {
		process.loadEnvFile?.();
	} else if (process.env.NODE_ENV !== "test") {
		console.warn("[env] loadEnvFile 不可用,请手动注入环境变量");
	}
}