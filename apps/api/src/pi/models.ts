import { createModels } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import type { AppConfig } from "../env.js";

export interface ModelRuntime {
	models: ReturnType<typeof createModels>;
	streamFn: StreamFn;
}

export function createModelRegistry(): ModelRuntime {
	const providers: Record<string, Provider> = {
		deepseek: deepseekProvider(),
		openai: openaiProvider(),
	};
	const models = createModels();
	for (const provider of Object.values(providers)) models.setProvider(provider);

	const streamFn: StreamFn = async (model, context, options) => {
		const provider = providers[model.provider];
		if (!provider) throw new Error(`no provider registered for ${model.provider}`);
		const api = (provider as unknown as { api: Record<string, { stream: StreamFn }> }).api[model.api as string];
		if (!api?.stream) throw new Error(`no stream implementation for ${model.provider}/${model.api as string}`);
		return api.stream(model, context, options);
	};

	return { models, streamFn };
}

export function resolveModel(config: Pick<AppConfig, "modelProvider" | "modelId">) {
	return createModelRegistry().models.getModel(config.modelProvider, config.modelId);
}