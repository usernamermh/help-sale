import { num, record, str } from "./primitives.js";
import type { FileConfig } from "./file.js";
import type { ModelConfig } from "./types.js";

/**
 * 对应 help-sale.config.yaml 的 `model` 段:模型端点、密钥、代理、上下文窗口与额外请求体。
 * baseUrl 不含 /chat/completions(OpenAI 兼容客户端自动拼路径);extraBody 会统一放进请求体 extra_body。
 * 全部必填(proxy 留空写 "",extraBody 空写 {}),代码里不提供任何默认值。
 */
export function loadModelConfig(file: FileConfig): ModelConfig {
	return {
		modelId: str(file.model?.modelId, "model.modelId"),
		modelBaseUrl: str(file.model?.baseUrl, "model.baseUrl"),
		modelApiKey: str(file.model?.apiKey, "model.apiKey"),
		modelProxy: str(file.model?.proxy, "model.proxy"),
		modelContextWindow: num(file.model?.contextWindow, "model.contextWindow"),
		modelMaxTokens: num(file.model?.maxTokens, "model.maxTokens"),
		modelExtraBody: record(file.model?.extraBody, "model.extraBody"),
	};
}
