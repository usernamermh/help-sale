import type { DatabaseSync } from "node:sqlite";
import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { createModelRegistry, requiredModel, type ModelRuntime } from "./models.js";
import { getCopilotSystemPrompt } from "../prompts/sales-copilot.js";
import { createCopilotTools, type AnalysisDetails } from "./tools.js";
import { config } from "../env.js";
import { appendUserMessage, buildConversationText, type SessionStore } from "./sessions.js";
import { parseTranscript, type ConversationMessage } from "../services/conversation.js";
import { createTimelineRecorder } from "../services/timeline.js";

export interface CopilotDeps {
	db: DatabaseSync;
	tenantId: string;
	store: SessionStore;
	runtime?: ModelRuntime;
	streamFn?: StreamFn;
}

export interface RunAnalysisInput {
	transcript?: string;
	messages?: ConversationMessage[];
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
	const convo = input.messages && input.messages.length > 0 ? input.messages : parseTranscript(input.transcript ?? "");
	if (convo.length === 0) throw new Error("conversation is empty");
	const text = buildConversationText(convo);
	await appendUserMessage(session, text);


	const model = requiredModel(runtime);

	const tools = await createCopilotTools({ db, tenantId });
	const systemPrompt = getCopilotSystemPrompt({ companyName: config.companyName, teamName: config.teamName });
	const agent = makeAgent({ sessionId: conversationId, systemPrompt, tools, streamFn, model });
	const recorder = createTimelineRecorder(db, { tenantId, conversationId });
	agent.subscribe((event) => recorder.listen(event));

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

	await recorder.flush();

	return { conversationId, details, messages: result };
}