import type { AgentEvent } from "@earendil-works/pi-agent-core";

export interface ClientEvent {
	type: string;
	toolName?: string;
	toolCallId?: string;
	payload?: unknown;
}

export function toClientEvents(event: AgentEvent): ClientEvent[] {
	switch (event.type) {
		case "agent_start":
			return [{ type: "agent_start" }];
		case "agent_end":
			return [{ type: "agent_end", payload: { messageCount: event.messages.length } }];
		case "message_start":
			return [{ type: "message", payload: event.message }];
		case "message_update": {
			const streamEvent = (event as { assistantMessageEvent?: { type?: string; delta?: string } }).assistantMessageEvent;
			if (streamEvent?.type === "text_delta" && typeof streamEvent.delta === "string") {
				return [{ type: "text_delta", payload: { text: streamEvent.delta } }];
			}
			return [{ type: "message_update", payload: event.message }];
		}
		case "message_end":
			return [{ type: "message_end" }];
		case "tool_execution_start":
			return [{ type: "tool_start", toolCallId: event.toolCallId, toolName: event.toolName, payload: event.args }];
		case "tool_execution_update":
			return [{ type: "tool_update", toolCallId: event.toolCallId, toolName: event.toolName, payload: event.partialResult }];
		case "tool_execution_end":
			return [{ type: "tool_end", toolCallId: event.toolCallId, toolName: event.toolName, payload: event.result }];
		case "turn_start":
		case "turn_end":
			return [];
		default: {
			const unknownEvent = event as { type: string };
			return [{ type: unknownEvent.type }];
		}
	}
}