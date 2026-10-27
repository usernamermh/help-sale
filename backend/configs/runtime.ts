import { bool, logLevel, num, str } from "./primitives.js";
import type { FileConfig } from "./file.js";
import type { RuntimeConfig } from "./types.js";

/**
 * 对应 help-sale.config.yaml 的 `server` 与 `logging` 两段:监听地址 + 运行日志。
 * 全部必填(含 logging.level 与 logging.runtimeFile),代码里不提供任何默认值。
 */
export function loadRuntimeConfig(file: FileConfig): RuntimeConfig {
	return {
		host: str(file.server?.host, "server.host"),
		port: num(file.server?.port, "server.port"),
		logEnabled: bool(file.logging?.enabled, "logging.enabled"),
		logDir: str(file.logging?.dir, "logging.dir"),
		logMaxBytes: num(file.logging?.maxBytes, "logging.maxBytes"),
		logLevel: logLevel(file.logging?.level, "logging.level"),
		logRuntimeFile: str(file.logging?.runtimeFile, "logging.runtimeFile"),
	};
}
