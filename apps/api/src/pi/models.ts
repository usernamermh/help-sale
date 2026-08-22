import { createModels } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { createLocalProvider } from "./local-provider.js";
import { loadConfig, type AppConfig } from "../env.js";

export interface ModelRuntime {
	models: ReturnType<typeof createModels>;
	streamFn: StreamFn;
}

export interface ModelRegistryOptions {
	baseUrl: string;
	modelId: string;
	apiKey: string;
	contextWindow?: number;
	maxTokens?: number;
	extraBody?: Record<string, unknown>;
}

export function createModelRegistry(options?: ModelRegistryOptions): ModelRuntime {
	const appConfig = loadConfig();
	const cfg = options ?? {
		baseUrl: appConfig.modelBaseUrl,
		modelId: appConfig.modelId,
		apiKey: appConfig.modelApiKey,
		contextWindow: appConfig.modelContextWindow,
		maxTokens: appConfig.modelMaxTokens,
	};
	const providers: Record<string, Provider> = {
		deepseek: deepseekProvider(),
		openai: openaiProvider(),
		"local-llm": createLocalProvider(cfg),
	};
	const models = createModels();
	for (const provider of Object.values(providers)) models.setProvider(provider);

	const extraBody = cfg.extraBody ?? appConfig.modelExtraBody;

	// 自定义 fetch:把额外参数统一塞进请求体 body 的 extra_body 字段,
	// 不与标准 OpenAI 参数平级;仅对 JSON body 生效,失败时原样透传。
	const fetchWithExtraBody: typeof fetch = (input, init) => {
		const bodyText = typeof init?.body === "string" ? init.body : null;
		if (bodyText) {
			try {
				const nextBody = injectExtraBody(bodyText, extraBody);
				return globalThis.fetch(input, { ...init, body: nextBody });
			} catch {
				// 非 JSON body,原样透传
			}
		}
		return globalThis.fetch(input, init);
	};

	const streamFn: StreamFn = async (model, context, options) => {
		if (Object.keys(extraBody).length > 0) {
			return models.stream(model, context, { ...(options ?? {}), fetch: fetchWithExtraBody });
		}
		return models.stream(model, context, options);
	};

	return { models, streamFn };
}

export function resolveModel(config?: Pick<AppConfig, "modelProvider" | "modelId">) {
	const cfg = config ?? loadConfig();
	return createModelRegistry().models.getModel(cfg.modelProvider, cfg.modelId);
}
/**
 * 把额外参数注入 OpenAI 兼容请求体:统一放进 extra_body 字段,不与标准参数平级。
 * body 非 JSON 时原样返回;已有 extra_body 的保留并合并。
 */
export function injectExtraBody(bodyText: string, extra: Record<string, unknown>): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(bodyText);
	} catch {
		return bodyText;
	}
	if (!parsed || typeof parsed !== "object" || Object.keys(extra).length === 0) return bodyText;
	const obj = parsed as Record<string, unknown>;
	const mergedExtra = { ...((obj.extra_body as Record<string, unknown>) ?? {}), ...extra };
	return JSON.stringify({ ...obj, extra_body: mergedExtra });
}