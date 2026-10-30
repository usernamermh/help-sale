/**
 * 配置模块的唯一出口与汇总点。
 *
 * 解析实现按 help-sale.config.yaml 的配置段拆在 ./configs/ 下,这里负责把各段拼成完整配置并对外暴露:
 *
 *   server / logging                            → configs/runtime.ts
 *   data / tenant                               → configs/data.ts
 *   model                                       → configs/model.ts
 *   context.compression                         → configs/context.ts
 *   knowledge / chunker / vector                → configs/retrieval.ts
 *   mysql / redis / notification / tools / mcp  → configs/integrations.ts
 *   defaults / company / userkey                → configs/defaults.ts
 *   subagents / automation / workflows / client → configs/features.ts
 *   milvus_backend / milvus_docker_compose      → configs/milvus.ts
 *   weixin                                      → configs/weixin.ts
 *
 * 各段返回类型都由 Pick<AppConfig> 派生,漏赋值或写错字段会在编译期报错,不会静默产出残缺配置。
 * 新增配置项的顺序:types.ts 的 AppConfig 加字段 → 对应 configs 子文件赋值 → 配置文件写注释说明。
 *
 * 铁律:**代码里不写任何配置默认值**。所有配置项都必须由 help-sale.config.yaml 显式提供,
 * 缺项、类型不对、取值非法都会在加载配置时抛错并指出具体配置键(见 configs/primitives.ts);
 * 要"关掉/留空"请在配置文件里显式写 false / "" / []。
 */
import { loadConfigFile, loadContextConfig, loadDataConfig, loadDefaultsConfig, loadFeaturesConfig, loadIntegrationsConfig, loadMilvusDeployConfig, loadModelConfig, loadRetrievalConfig, loadRuntimeConfig, loadWeixinConfig } from "./configs/index.js";
import type { AppConfig } from "./configs/types.js";

/** 按配置段汇总出完整配置对象。 */
export function loadConfig(): AppConfig {
	const file = loadConfigFile();
	return {
		...loadRuntimeConfig(file),
		...loadDataConfig(file),
		...loadModelConfig(file),
		...loadContextConfig(file),
		...loadRetrievalConfig(file),
		...loadIntegrationsConfig(file),
		...loadDefaultsConfig(file),
		...loadFeaturesConfig(file),
		...loadMilvusDeployConfig(file),
		...loadWeixinConfig(file),
	};
}

/** 应用全局配置实例:各模块顶部直接 import { config } 使用,配置只来自 yaml。 */
export const config: AppConfig = loadConfig();

/** 配置文件定位/读取:留给测试与工具按需重载、校验配置文件本身。 */
export { loadConfigFile, locateConfigFile } from "./configs/index.js";
export type { AppConfig } from "./configs/types.js";
export type { FileConfig } from "./configs/file.js";
