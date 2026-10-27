import { createProvider, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

export interface LocalProviderOptions {
	baseUrl: string;
	modelId: string;
	apiKey?: string;
	contextWindow?: number;
	maxTokens?: number;
}

export function createLocalProvider(options: LocalProviderOptions) {
	const model: Model<"openai-completions"> = {
		id: options.modelId,
		provider: "local-llm",
		api: "openai-completions" as const,
		name: options.modelId,
		baseUrl: options.baseUrl.replace(/\/$/, ""),
		headers: { Authorization: `Bearer ${options.apiKey ?? "local-key"}` },
		reasoning: false,
		input: ["text"],
		contextWindow: options.contextWindow ?? 32768,
		maxTokens: options.maxTokens ?? 8192,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};

	return createProvider({
		id: "local-llm",
		name: "Local LLM",
		baseUrl: options.baseUrl,
		auth: {
			apiKey: {
				name: "Local API Key",
				resolve: async () => ({ auth: { apiKey: options.apiKey ?? "local-key" }, source: "local default" }),
			},
		},
		models: [model],
		api: { "openai-completions": openAICompletionsApi() },
	});
}