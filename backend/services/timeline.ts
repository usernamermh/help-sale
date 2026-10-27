/** Agent 运行时间线落库(经客户端事件适配器) */
import type { DatabaseSync } from "node:sqlite";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { toClientEvents } from "../integrations_pi/events-adapter.js";
import { appendAgentEvent } from "../integrations_pi/tables/agents/events.js";

export interface TimelineRecorder {
	listen(event: AgentEvent): void;
	/**
	 * 直接记录一条客户端事件(不经过 AgentEvent 适配)。
	 * 用于把非 agent 循环内的调用(工作流步骤)写进同一份运行轨迹:
	 * 事件先进入同一个 pending 缓冲,flush 时按调用顺序分配 seq,
	 * 因此与工作流步骤交错的主 agent 时间线顺序保持真实。
	 */
	record(eventType: "tool_start" | "tool_end", data: { toolName?: string; payload?: unknown }): void;
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
	input: { tenantId: string; conversationId: string; threadId?: string },
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
		record(eventType, data) {
			pending.push({
				eventType,
				toolName: data.toolName,
				payloadJson: data.payload !== undefined ? JSON.stringify(data.payload) : undefined,
			});
		},
		async flush() {
			for (const item of pending) {
				await appendAgentEvent(db, {
					tenantId: input.tenantId,
					conversationId: input.conversationId,
					threadId: input.threadId,
					...item,
				}).catch(() => undefined);
			}
			pending.length = 0;
		},
	};
}