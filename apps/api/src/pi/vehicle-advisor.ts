import type { DatabaseSync } from "node:sqlite";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { config } from "../env.js";
import { createModelRegistry, type ModelRuntime } from "./models.js";
import { getVehicleAdvisorPrompt } from "../prompts/vehicle-advisor.js";
import { createVehicleTools, type VehiclePlanDetails } from "./vehicle-tools.js";
import { appendUserMessage, type SessionStore } from "./sessions.js";
import { makeAgent } from "./copilot.js";
import { createTimelineRecorder } from "../services/timeline.js";

export interface VehicleAdvisorDeps {
	db: DatabaseSync;
	tenantId: string;
	store: SessionStore;
	runtime?: ModelRuntime;
	streamFn?: StreamFn;
}

export interface VehicleMatchInput {
	requirementsText: string;
	customerKey?: string;
}

export interface VehicleMatchResult {
	conversationId: string;
	details?: VehiclePlanDetails;
	messages: unknown[];
}

export async function runVehicleMatch(deps: VehicleAdvisorDeps, input: VehicleMatchInput): Promise<VehicleMatchResult> {
	const { db, tenantId, store } = deps;
	const runtime = deps.runtime ?? createModelRegistry();
	const streamFn = deps.streamFn ?? runtime.streamFn;

	const model = runtime.models.getModel(config.modelProvider, config.modelId);
	if (!model) throw new Error(`model not found: ${config.modelProvider}/${config.modelId}`);

	const { session, conversationId } = await store.createConversation();
	await appendUserMessage(session, input.requirementsText);

	const tools = createVehicleTools({ db, tenantId });
	const systemPrompt = getVehicleAdvisorPrompt({ companyName: config.companyName });
	const agent = makeAgent({ sessionId: conversationId, systemPrompt, tools, streamFn, model });
	const recorder = createTimelineRecorder(db, { tenantId, conversationId });
	agent.subscribe((event) => recorder.listen(event));

	await agent.prompt(input.requirementsText);
	const messages = agent.state.messages;

	for (const message of messages) {
		if (message.role === "user") continue;
		await session.appendMessage(message as never).catch(() => undefined);
	}

	let details: VehiclePlanDetails | undefined;
	for (const message of messages) {
		if (message.role === "toolResult" && (message as { toolName?: string }).toolName === "emit_vehicle_plan") {
			details = (message as { details?: VehiclePlanDetails }).details;
		}
	}

	await recorder.flush();

	return { conversationId, details, messages };
}