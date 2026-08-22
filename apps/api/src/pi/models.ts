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
}

export function createModelRegistry(options?: ModelRegistryOptions): ModelRuntime {
	const cfg = options ?? {
		baseUrl: process.env.MODEL_BASE_URL ?? "http://10.252.60.39:31883/v1",
		modelId: process.env.MODEL_ID ?? "u21-preview",
		apiKey: process.env.MODEL_API_KEY ?? "local-key",
	};
	const providers: Record<string, Provider> = {
		deepseek: deepseekProvider(),
		openai: openaiProvider(),
		"local-llm": createLocalProvider(cfg),
	};
	const models = createModels();
	for (const provider of Object.values(providers)) models.setProvider(provider);

	const streamFn: StreamFn = async (model, context, options) => models.stream(model, context, options);

	return { models, streamFn };
}

export function resolveModel(config?: Pick<AppConfig, "modelProvider" | "modelId">) {
	const cfg = config ?? loadConfig();
	return createModelRegistry().models.getModel(cfg.modelProvider, cfg.modelId);
}