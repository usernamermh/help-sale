import type { DatabaseSync } from "node:sqlite";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { toClientEvents } from "../pi/events-adapter.js";
import { appendAgentEvent } from "../repositories/agent-events.js";

export interface TimelineRecorder {
	listen(event: AgentEvent): void;
	flush(): Promise<void>;
}

interface PendingEvent {
	eventType: string;
	toolName?: string;
	payloadJson?: string;
}

/** 采集一次 agent 运行的事件序列(经客户端事件适配器),运行结束后一次性落库。 */
export function createTimelineRecorder(
	db: DatabaseSync,
	input: { tenantId: string; conversationId: string },
): TimelineRecorder {
	const pending: PendingEvent[] = [];
	return {
		listen(event) {
			for (const clientEvent of toClientEvents(event)) {
				pending.push({
					eventType: clientEvent.type,
					toolName: clientEvent.toolName,
					payloadJson:
						clientEvent.payload !== undefined ? JSON.stringify(clientEvent.payload) : undefined,
				});
			}
		},
		async flush() {
			for (const item of pending) {
				await appendAgentEvent(db, {
					tenantId: input.tenantId,
					conversationId: input.conversationId,
					...item,
				}).catch(() => undefined);
			}
			pending.length = 0;
		},
	};
}