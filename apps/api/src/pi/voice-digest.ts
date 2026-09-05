import type { DatabaseSync } from "node:sqlite";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { config } from "../env.js";
import { createModelRegistry, type ModelRuntime } from "./models.js";
import { getVoiceDigestPrompt } from "../prompts/voice-digest.js";
import { createVoiceDigestTools, type VoiceDigestDetails } from "./voice-digest-tools.js";
import { appendUserMessage, type SessionStore } from "./sessions.js";
import { makeAgent } from "./copilot.js";
import { createTimelineRecorder } from "../services/timeline.js";

export interface VoiceDigestDeps {
	db: DatabaseSync;
	tenantId: string;
	store: SessionStore;
	runtime?: ModelRuntime;
	streamFn?: StreamFn;
}

export async function runVoiceDigest(deps: VoiceDigestDeps, input: { text: string }): Promise<{ conversationId: string; details?: VoiceDigestDetails }> {
	const { db, tenantId, store } = deps;
	const runtime = deps.runtime ?? createModelRegistry();
	const streamFn = deps.streamFn ?? runtime.streamFn;

	const model = runtime.models.getModel(config.modelProvider, config.modelId);
	if (!model) throw new Error(`model not found: ${config.modelProvider}/${config.modelId}`);

	const { session, conversationId } = await store.createConversation();
	await appendUserMessage(session, input.text);

	const tools = await createVoiceDigestTools({ db, tenantId });
	const systemPrompt = getVoiceDigestPrompt({ companyName: config.companyName });
	const agent = makeAgent({ sessionId: conversationId, systemPrompt, tools, streamFn, model });
	const recorder = createTimelineRecorder(db, { tenantId, conversationId });
	agent.subscribe((event) => recorder.listen(event));

	await agent.prompt(input.text);
	const messages = agent.state.messages;
	for (const message of messages) {
		if (message.role === "user") continue;
		await session.appendMessage(message as never).catch(() => undefined);
	}
	let details: VoiceDigestDetails | undefined;
	for (const message of messages) {
		if (message.role === "toolResult" && (message as { toolName?: string }).toolName === "emit_digest") {
			details = (message as { details?: VoiceDigestDetails }).details;
		}
	}
	await recorder.flush();
	return { conversationId, details };
}