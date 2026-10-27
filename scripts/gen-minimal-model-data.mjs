// Fix: emit one model per supported api group, so Provider api generics infer all groups.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "pi", "packages", "ai");
const dataDir = join(packageRoot, "src", "providers", "data");

const API_BY_CALL = {
	openAICompletionsApi: "openai-completions",
	openAIResponsesApi: "openai-responses",
	azureOpenAIResponsesApi: "azure-openai-responses",
	openAICodexResponsesApi: "openai-codex-responses",
	anthropicMessagesApi: "anthropic-messages",
	bedrockConverseStreamApi: "bedrock-converse-stream",
	googleGenerativeAIApi: "google-generative-ai",
	googleVertexApi: "google-vertex",
	mistralConversationsApi: "mistral-conversations",
	piMessagesApi: "pi-messages",
};

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}
function sortedRecord(entries) {
	return Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

const aggregator = readFileSync(join(packageRoot, "src", "models.generated.ts"), "utf8");
const pattern = /^import \{ [A-Z][A-Z0-9_]*_MODELS \} from "\.\/providers\/([^"/]+)\.models\.ts";$/gm;
const providerIds = [...aggregator.matchAll(pattern)].map((m) => m[1]).sort();
if (providerIds.length === 0) throw new Error("no provider ids extracted");

function apisForProvider(providerId) {
	const src = readFileSync(join(packageRoot, "src", "providers", `${providerId}.ts`), "utf8");
	const calls = [...src.matchAll(/\b([A-Za-z]+Api)\(/g)].map((m) => m[1]);
	const apis = [...new Set(calls)].map((c) => API_BY_CALL[c]).filter(Boolean);
	if (apis.length === 0) throw new Error(`cannot map api calls for ${providerId}`);
	return apis;
}

function model(providerId, api, modelId) {
	return {
		id: modelId,
		provider: providerId,
		api,
		name: modelId,
		baseUrl: ["bedrock-converse-stream", "google-generative-ai", "google-vertex"].includes(api)
			? `https://${api}.example.invalid`
			: "https://placeholder.invalid",
		reasoning: false,
		input: ["text"],
		contextWindow: 8192,
		maxTokens: 4096,
		cost: { input: 0.000001, output: 0.000002, cacheRead: 0, cacheWrite: 0 },
	};
}

const REAL = {
	deepseek: { "deepseek-chat": "DeepSeek Chat", "deepseek-reasoner": "DeepSeek Reasoner" },
	openai: { "gpt-4o": "GPT-4o", "gpt-4o-mini": "GPT-4o mini", "o3-mini": "o3 mini" },
};

const structure = {};
const files = {};
mkdirSync(dataDir, { recursive: true });

for (const providerId of providerIds) {
	const apis = apisForProvider(providerId);
	const groups = {};
	const ids = [];
	for (const api of apis) {
		const members = REAL[providerId] && api === (apis.length === 1 ? apis[0] : Object.keys(REAL[providerId]).length ? apis[0] : api)
			? REAL[providerId]
			: { [`${providerId}-${api}`]: `${providerId} (${api})` };
		for (const [id, name] of Object.entries(members)) {
			groups[api] = groups[api] ?? {};
			groups[api][id] = model(providerId, api, id);
			ids.push([id, api]);
		}
	}
	const content = JSON.stringify(groups, null, "\t") + "\n";
	writeFileSync(join(dataDir, `${providerId}.json`), content);
	structure[providerId] = sortedRecord(ids);
	files[`${providerId}.json`] = sha256(content);
}

const normalized = sortedRecord(
	Object.entries(structure).map(([providerId, models]) => [providerId, sortedRecord(Object.entries(models))]),
);
const manifest = {
	schemaVersion: 3,
	generatedAt: new Date().toISOString(),
	structureHash: sha256(JSON.stringify(normalized)),
	files: sortedRecord(Object.entries(files)),
};
writeFileSync(join(dataDir, ".manifest.json"), JSON.stringify(manifest, null, "\t") + "\n");
console.log(`wrote ${providerIds.length} provider files, structureHash ${manifest.structureHash}`);