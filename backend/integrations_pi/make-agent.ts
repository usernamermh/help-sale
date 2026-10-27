import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";

/**
 * 通用 Agent 工厂(系统组件):
 * 创建 pi-agent 实例,装配系统提示词、工具列表、模型与流式函数。
 * 供各业务 Agent(copilot / evaluator / voice-digest 等)复用。
 */
export function makeAgent(options: { sessionId?: string; systemPrompt: string; tools: unknown[]; streamFn: StreamFn; model: Model<any> }) {
	return new Agent({
		sessionId: options.sessionId,
		streamFn: options.streamFn,
		initialState: { systemPrompt: options.systemPrompt, tools: options.tools as never, model: options.model },
	});
}
