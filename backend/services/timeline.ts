/** Agent 运行时间线落库(经客户端事件适配器) */
import type { DatabaseSync } from "node:sqlite";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { toClientEvents } from "../integrations_pi/events-adapter.js";
import { appendAgentEvents } from "../integrations_pi/tables/agents/events.js";

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

/** 只服务实时展示、不落库的事件类型。 */
const STREAMING_ONLY_EVENTS = new Set(["text_delta", "message_update", "tool_update"]);

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
				// 流式碎片(逐字增量、中间态)只用于实时展示,回放靠 message / tool_* 就够;
				// 它们占事件总数九成以上,逐条落库会把一轮几十次 SQL 变成上百次。
				if (STREAMING_ONLY_EVENTS.has(clientEvent.type)) continue;
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
			if (pending.length === 0) return;
			const items = pending.splice(0, pending.length);
			try {
				await appendAgentEvents(db, {
					tenantId: input.tenantId,
					conversationId: input.conversationId,
					threadId: input.threadId,
					events: items,
				});
			} catch (error) {
				// 轨迹写失败不影响本轮结果(原实现也是逐条吞错)
				console.warn(`[timeline] 轨迹落库失败: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
	};
}