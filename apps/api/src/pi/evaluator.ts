import type { DatabaseSync } from "node:sqlite";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { loadConfig } from "../env.js";
import { createModelRegistry, type ModelRuntime } from "./models.js";
import { getEvaluatorPrompt } from "../prompts/evaluator.js";
import { createEvaluatorTools, type EvaluationDetails } from "./evaluator-tools.js";
import { appendUserMessage, type SessionStore } from "./sessions.js";
import { makeAgent } from "./copilot.js";
import { createTimelineRecorder } from "../services/timeline.js";

export interface EvaluatorDeps {
	db: DatabaseSync;
	tenantId: string;
	store: SessionStore;
	runtime?: ModelRuntime;
	streamFn?: StreamFn;
}

export interface EvaluationResult {
	conversationId: string;
	details?: EvaluationDetails;
	messages: unknown[];
}

export async function runResponseEvaluation(deps: EvaluatorDeps, input: { text: string }): Promise<EvaluationResult> {
	const { db, tenantId, store } = deps;
	const runtime = deps.runtime ?? createModelRegistry();
	const streamFn = deps.streamFn ?? runtime.streamFn;
	const config = loadConfig();
	const model = runtime.models.getModel(config.modelProvider, config.modelId);
	if (!model) throw new Error(`model not found: ${config.modelProvider}/${config.modelId}`);

	const { session, conversationId } = await store.createConversation();
	await appendUserMessage(session, input.text);

	const tools = createEvaluatorTools({ db, tenantId });
	const systemPrompt = getEvaluatorPrompt({ companyName: config.companyName });
	const agent = makeAgent({ sessionId: conversationId, systemPrompt, tools, streamFn, model });
	const recorder = createTimelineRecorder(db, { tenantId, conversationId });
	agent.subscribe((event) => recorder.listen(event));

	await agent.prompt(input.text);
	const messages = agent.state.messages;

	for (const message of messages) {
		if (message.role === "user") continue;
		await session.appendMessage(message as never).catch(() => undefined);
	}

	let details: EvaluationDetails | undefined;
	for (const message of messages) {
		if (message.role === "toolResult" && (message as { toolName?: string }).toolName === "emit_evaluation") {
			details = (message as { details?: EvaluationDetails }).details;
		}
	}

	await recorder.flush();
	return { conversationId, details, messages };
}