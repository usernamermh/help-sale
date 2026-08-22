export function loadEnv(): void {
	if (typeof process.loadEnvFile === "function") {
		process.loadEnvFile?.();
	} else if (process.env.NODE_ENV !== "test") {
		console.warn("[env] loadEnvFile 不可用,请手动注入环境变量");
	}
}

export interface AppConfig {
	port: number;
	dataDir: string;
	businessDbPath: string;
	sessionDbPath: string;
	modelProvider: string;
	modelId: string;
	tenantId: string; // MVP:固定演示租户,后续迁移到认证
}

export function loadConfig(): AppConfig {
	return {
		port: Number(process.env.PORT ?? 3000),
		dataDir: process.env.DATA_DIR ?? "apps/api/data",
		businessDbPath: process.env.BUSINESS_DB ?? "apps/api/data/business.db",
		sessionDbPath: process.env.SESSION_DB ?? "apps/api/data/pi-sessions.db",
		modelProvider: process.env.MODEL_PROVIDER ?? "deepseek",
		modelId: process.env.MODEL_ID ?? "deepseek-chat",
		tenantId: process.env.TENANT_ID ?? "t_demo",
	};
}