import type { DatabaseSync } from "node:sqlite";
import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { createModelRegistry, type ModelRuntime } from "./models.js";
import { getCopilotSystemPrompt } from "../prompts/sales-copilot.js";
import { createCopilotTools, type AnalysisDetails } from "./tools.js";
import { loadConfig } from "../env.js";
import { appendUserMessage, buildConversationText, type SessionStore } from "./sessions.js";

export interface CopilotDeps {
	db: DatabaseSync;
	tenantId: string;
	store: SessionStore;
	companyName?: string;
	runtime?: ModelRuntime;
	streamFn?: StreamFn;
}

export interface RunAnalysisInput {
	transcript: string;
	customerKey?: string;
}

export interface RunAnalysisResult {
	conversationId: string;
	details?: AnalysisDetails;
	messages: unknown[];
}

export function makeAgent(options: { sessionId?: string; systemPrompt: string; tools: unknown[]; streamFn: StreamFn; model: Model<any> }) {
	return new Agent({
		sessionId: options.sessionId,
		streamFn: options.streamFn,
		initialState: { systemPrompt: options.systemPrompt, tools: options.tools as never, model: options.model },
	});
}

export async function runCopilotAnalysis(deps: CopilotDeps, input: RunAnalysisInput): Promise<RunAnalysisResult> {
	const { db, tenantId, store } = deps;
	const runtime = deps.runtime ?? createModelRegistry();
	const streamFn = deps.streamFn ?? runtime.streamFn;

	const { session, conversationId } = await store.createConversation();
	const text = buildConversationText([{ role: "customer", content: input.transcript }]);
	await appendUserMessage(session, text);

	const config = loadConfig();
	const model = runtime.models.getModel(config.modelProvider, config.modelId);
	if (!model) throw new Error(`model not found: ${config.modelProvider}/${config.modelId}`);

	const tools = createCopilotTools({ db, tenantId, searchLimit: config.knowledgeSearchLimit });
	const systemPrompt = getCopilotSystemPrompt({ companyName: deps.companyName ?? config.companyName, teamName: config.teamName });
	const agent = makeAgent({ sessionId: conversationId, systemPrompt, tools, streamFn, model });

	await agent.prompt(text);

	const result = agent.state.messages;
	for (const message of result) {
		if (message.role === "user") continue;
		await session.appendMessage(message as never).catch(() => undefined);
	}

	let details: AnalysisDetails | undefined;
	for (const message of result) {
		if (message.role === "toolResult" && (message as { toolName?: string }).toolName === "emit_analysis") {
			details = (message as { details?: AnalysisDetails }).details;
		}
	}

	return { conversationId, details, messages: result };
}