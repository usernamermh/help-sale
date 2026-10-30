/**
 * 配置子模块集合出入口:方便按需只取某一段(比如单独加载检索段、单独校验配置文件),
 * 完整配置的汇总与对外出口在 ../env.ts —— 那里按下面的对照关系把各段拼成 AppConfig。
 *
 * 各段一律"必填即校验":读不到的配置项直接抛错,代码里不提供默认值(见 primitives.ts)。
 *
 *   server / logging                            → runtime.ts
 *   data / tenant                               → data.ts
 *   model                                       → model.ts
 *   context.compression                         → context.ts
 *   knowledge / chunker / vector                → retrieval.ts
 *   mysql / redis / notification / tools / mcp  → integrations.ts
 *   weixin                                      → weixin.ts
 *   defaults / company / userkey                → defaults.ts
 *   subagents / automation / workflows / client → features.ts
 *   类型(完整 AppConfig + 各段切片)            → types.ts
 *   解析原语(必填写校验口径)                   → primitives.ts
 *   配置文件定位与 YAML 读取                    → file.ts
 */
export { loadConfigFile, locateConfigFile } from "./file.js";
export { loadRuntimeConfig } from "./runtime.js";
export { loadDataConfig } from "./data.js";
export { loadModelConfig } from "./model.js";
export { loadContextConfig } from "./context.js";
export { loadRetrievalConfig } from "./retrieval.js";
export { loadIntegrationsConfig } from "./integrations.js";
export { loadDefaultsConfig } from "./defaults.js";
export { loadFeaturesConfig } from "./features.js";
export { loadMilvusDeployConfig } from "./milvus.js";
export { loadWeixinConfig } from "./weixin.js";
export type * from "./types.js";
export type { FileConfig } from "./file.js";
