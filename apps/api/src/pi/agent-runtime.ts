import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Agent, type AgentMessage, type StreamFn } from "@earendil-works/pi-agent-core";
import { createModelRegistry, type ModelRuntime } from "./models.js";
import { getSalesAgentSystemPrompt } from "../prompts/sales-agent.js";
import { createSalesAgentTools } from "./agent-tools.js";
import { config } from "../env.js";
import { createTimelineRecorder } from "../services/timeline.js";
import { listCapabilityStates } from "../repositories/agent-capabilities.js";
import { toClientEvents } from "./events-adapter.js";
import { toolLabel } from "./capabilities.js";
import type { SessionStore } from "./sessions.js";

export interface SalesAgentDeps {
	db: DatabaseSync;
	tenantId: string;
	store: SessionStore;
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


/** 从 assistant 消息 content(TextContent[] 或字符串)提取纯文本。 */
function assistantText(content: unknown): string {
	if (!content) return "";
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((c) => {
				const item = c as { type?: string; text?: string };
				return typeof item?.text === "string" ? item.text : "";
			})
			.join("");
	}
	return "";
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

	const model = runtime.models.getModel(config.modelProvider, config.modelId);
	if (!model) throw new Error(`model not found: ${config.modelProvider}/${config.modelId}`);

	const systemPrompt = getSalesAgentSystemPrompt({
		companyName: config.companyName,
		teamName: config.teamName,
	});
	const capabilityStates = listCapabilityStates(db, tenantId);
	const disabled = new Set(capabilityStates.filter((c) => !c.enabled).map((c) => c.name));
	const tools = (await createSalesAgentTools({ db, tenantId, store })).filter(
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
	// 兜底:模型可能不调用 emit_final 而直接输出普通文本;此时把最后一条 assistant 文本作为最终答复
	if (!final) {
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i] as { role?: string; content?: unknown };
			if (message.role !== "assistant") continue;
			const text = assistantText(message.content);
			if (text.trim()) {
				final = { answer: text.trim(), summary: undefined, nextSteps: [] };
				break;
			}
		}
	}

	return { runId, final, messages };
}