import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Agent, type AgentMessage, type StreamFn } from "@earendil-works/pi-agent-core";
import { createModelRegistry, type ModelRuntime } from "./models.js";
import { getSalesAgentSystemPrompt } from "../prompts/sales-agent.js";
import { createSalesAgentTools } from "./agent-tools.js";
import { loadConfig } from "../env.js";
import { createTimelineRecorder } from "../services/timeline.js";
import { listCapabilityStates } from "../repositories/agent-capabilities.js";
import { toClientEvents } from "./events-adapter.js";
import { toolLabel } from "./capabilities.js";
import type { SessionStore } from "./sessions.js";

export interface SalesAgentDeps {
	db: DatabaseSync;
	tenantId: string;
	store: SessionStore;
	companyName?: string;
	teamName?: string;
	runtime?: ModelRuntime;
	streamFn?: StreamFn;
}

export interface AgentProgressEvent {
	type: "tool_start" | "tool_end" | "tool_update";
	toolCallId?: string;
	toolName?: string;
	label?: string;
	payload?: unknown;
}

export interface SalesAgentInput {
	goal: string;
	customerKey?: string;
	conversationId?: string;
	history?: AgentMessage[];
	onProgress?: (event: AgentProgressEvent) => void;
}

export interface AgentFinal {
	answer: string;
	summary?: string;
	nextSteps: string[];
}

export interface SalesAgentResult {
	runId: string;
	final?: AgentFinal;
	messages: unknown[];
}

export async function runSalesAgent(deps: SalesAgentDeps, input: SalesAgentInput): Promise<SalesAgentResult> {
	const { db, tenantId, store } = deps;
	if (!input.goal || !input.goal.trim()) throw new Error("goal is empty");

	const runtime = deps.runtime ?? createModelRegistry();
	const streamFn = deps.streamFn ?? runtime.streamFn;
	const config = loadConfig();
	const model = runtime.models.getModel(config.modelProvider, config.modelId);
	if (!model) throw new Error(`model not found: ${config.modelProvider}/${config.modelId}`);

	const systemPrompt = getSalesAgentSystemPrompt({
		companyName: deps.companyName ?? config.companyName,
		teamName: deps.teamName ?? config.teamName,
	});
	const capabilityStates = listCapabilityStates(db, tenantId);
	const disabled = new Set(capabilityStates.filter((c) => !c.enabled).map((c) => c.name));
	const tools = createSalesAgentTools({ db, tenantId, store, searchLimit: config.knowledgeSearchLimit }).filter(
		(t) => t.name === "emit_final" || !disabled.has(t.name),
	);

	const runId = randomUUID();
	const annotations: string[] = [];
	if (input.customerKey) annotations.push(`目标客户标识: ${input.customerKey}`);
	if (input.conversationId) annotations.push(`目标会话 ID: ${input.conversationId}`);
	const goalText = annotations.length ? `${input.goal}\n\n${annotations.join("\n")}` : input.goal;

	const stateMessages = Array.isArray(input.history) ? input.history : [];
	const agent = new Agent({
		sessionId: runId,
		streamFn,
		initialState: { systemPrompt, tools: tools as never, model, messages: stateMessages },
	});

	const recorder = createTimelineRecorder(db, { tenantId, conversationId: runId });
	agent.subscribe((event) => {
		recorder.listen(event);
		if (input.onProgress) {
			for (const ce of toClientEvents(event)) {
				if (ce.type === "tool_start" || ce.type === "tool_end" || ce.type === "tool_update") {
					input.onProgress({ type: ce.type, toolCallId: ce.toolCallId, toolName: ce.toolName, label: toolLabel(ce.toolName), payload: ce.payload });
				}
			}
		}
	});

	try {
		await agent.prompt(goalText);
		await recorder.flush();
	} catch (error) {
		await recorder.flush().catch(() => undefined);
		throw error;
	}

	const messages = agent.state.messages;
	let final: AgentFinal | undefined;
	for (const message of messages) {
		if (message.role === "toolResult" && (message as { toolName?: string }).toolName === "emit_final") {
			const details = (message as { details?: Partial<AgentFinal> }).details;
			if (details?.answer) {
				final = {
					answer: details.answer,
					summary: details.summary,
					nextSteps: Array.isArray(details.nextSteps) ? details.nextSteps : [],
				};
			}
		}
	}

	return { runId, final, messages };
}