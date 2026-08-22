import { createModels } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import type { AppConfig } from "../env.js";

export function createModelRegistry() {
	const models = createModels();
	models.setProvider(deepseekProvider());
	models.setProvider(openaiProvider());
	return models;
}

export function resolveModel(config: Pick<AppConfig, "modelProvider" | "modelId">) {
	return createModelRegistry().getModel(config.modelProvider, config.modelId);
}