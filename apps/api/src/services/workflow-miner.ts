import type { DatabaseSync } from "node:sqlite";
import { Agent } from "@earendil-works/pi-agent-core";
import { createModelRegistry } from "../pi/models.js";
import { config } from "../env.js";

/** 系统收口/编排类工具:不作为工作流步骤挖掘。 */
const SYSTEM_TOOLS = new Set([
	"emit_final", "emit_plan", "emit_analysis", "emit_evaluation", "emit_vehicle_plan", "emit_digest",
	"kanban", "subagents", "verify", "update_memory",
]);

export interface MinedChain {
	chain: string[];
	count: number;
	sampleArgs: Array<Record<string, unknown>>;
}

export interface RefinedWorkflow {
	name: string;
	description: string;
	steps: Array<{ name: string; tool: string; params?: Record<string, unknown>; outputVar?: string }>;
}

/** 低信息/噪声工具:不作为工作流步骤(大量重复的底层数据访问)。 */
const NOISE_TOOLS = new Set(["sql", "date_tool", "browser", "computer", "redis", "txt", "excel", "ppt", "file_read"]);

/** 从 agent_events 挖掘高频工具调用子序列:过滤系统/噪声工具、折叠连续重复、按 2~4 步滑动窗口聚合。 */
export function mineToolChains(db: DatabaseSync, tenantId: string, days = 14): MinedChain[] {
	const since = new Date(Date.now() - days * 86400000).toISOString();
	const rows = db
		.prepare(
			"SELECT conversation_id, tool_name, payload_json, seq FROM agent_events WHERE tenant_id = ? AND event_type = 'tool_start' AND created_at >= ? ORDER BY conversation_id, seq",
		)
		.all(tenantId, since) as Array<{ conversation_id: string; tool_name: string | null; payload_json: string | null }>;

	// 按运行分组,过滤系统/噪声工具,折叠连续重复
	const byRun = new Map<string, Array<{ tool: string; args: Record<string, unknown> }>>();
	for (const r of rows) {
		const tool = String(r.tool_name ?? "");
		if (!tool || SYSTEM_TOOLS.has(tool) || NOISE_TOOLS.has(tool)) continue;
		let args: Record<string, unknown> = {};
		try { args = JSON.parse(String(r.payload_json ?? "{}")) as Record<string, unknown>; } catch { /* 忽略 */ }
		const arr = byRun.get(String(r.conversation_id)) ?? [];
		if (arr.length && arr[arr.length - 1].tool === tool) continue; // 折叠连续重复
		arr.push({ tool, args });
		byRun.set(String(r.conversation_id), arr);
	}

	// 滑动窗口提取 2~4 步子序列(每个 run 内去重),全局聚合计数
	const freq = new Map<string, { count: number; sampleArgs: Array<Record<string, unknown>> }>();
	for (const [, seq] of byRun) {
		if (seq.length < 2) continue;
		const seen = new Set<string>();
		for (let w = 2; w <= Math.min(4, seq.length); w++) {
			for (let i = 0; i + w <= seq.length; i++) {
				const win = seq.slice(i, i + w);
				const key = win.map((x) => x.tool).join("→");
				if (seen.has(key)) continue;
				seen.add(key);
				const e = freq.get(key) ?? { count: 0, sampleArgs: win.map(() => ({})) };
				e.count++;
				if (e.count <= 3) for (let j = 0; j < win.length; j++) e.sampleArgs[j] = win[j].args;
				freq.set(key, e);
			}
		}
	}

	return [...freq.entries()]
		.filter(([, v]) => v.count >= 2)
		.sort((a, b) => b[1].count - a[1].count)
		.slice(0, 8)
		.map(([chain, v]) => ({ chain: chain.split("→"), count: v.count, sampleArgs: v.sampleArgs }));
}

function assistantText(content: unknown): string {
	if (!content) return "";
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content.map((c) => { const item = c as { text?: string }; return typeof item?.text === "string" ? item.text : ""; }).join("");
	}
	return "";
}

/** 用 LLM 把工具链提炼成友好的工作流定义(命名/描述/参数占位/outputVar)。 */
export async function refineChainToWorkflow(chain: MinedChain): Promise<RefinedWorkflow> {
	const runtime = createModelRegistry();
	const model = runtime.models.getModel(config.modelProvider, config.modelId);
	if (!model) throw new Error(`model not found: ${config.modelProvider}/${config.modelId}`);
	const sample = chain.sampleArgs.map((args: Record<string, unknown>, i: number) => ({ step: chain.chain[i], args }));
	const prompt = `你是工作流设计师。下面是一次用户任务中 agent 连续调用的工具序列(出现 ${chain.count} 次),请把它提炼成一个可复用的工作流。
工具序列: ${chain.chain.join(" → ")}
参数示例: ${JSON.stringify(sample)}

要求只输出一个 \`\`\`json 代码块,内容是:
{
  "name": "简短中文工作流名称",
  "description": "一句话说明用途",
  "steps": [
    { "name": "步骤名", "tool": "工具名(必须来自序列)", "params": { 具体值用 {{param.字段名}} 占位,保留有意义的常量 }, "outputVar": "out1" }
  ]
}
不要输出其他内容。`;

	const agent = new Agent({
		sessionId: `wf-mine-${Date.now()}`,
		streamFn: runtime.streamFn,
		initialState: { systemPrompt: "", tools: [] as never, model, messages: [] },
	});
	await agent.prompt(prompt);
	const last = [...agent.state.messages].reverse().find((m: any) => m.role === "assistant") as { content?: unknown } | undefined;
	const raw = assistantText(last?.content);
	const block = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
	const jsonText = block ? block[1] : raw;
	const parsed = JSON.parse(jsonText) as RefinedWorkflow;
	if (!parsed.name || !Array.isArray(parsed.steps) || parsed.steps.length === 0) throw new Error("提炼结果缺少 name/steps");
	return parsed;
}
