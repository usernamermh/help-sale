import { Type } from "typebox";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { loadExternalAgentTools, TOOL_ROOTS } from "../services/external-tools.js";
import { listWorkflows, workflowToolName, type WorkflowRecord } from "./tables/agents/capabilities.js";
import { registerDynamicLabels } from "./capabilities.js";
import { checkWorkflowSteps, collectPlaceholders, loadStepToolNames, runWorkflowEngine, type WorkflowStep } from "../services/routes/workflows.js";
import type { TimelineRecorder } from "../services/timeline.js";
import type { SessionStore } from "./sessions.js";
import { config } from "../env.js";
import { McpClient, mcpToolToAgentTool } from "../mcp/client.js";
import { ToolCatalog, type CatalogEntry } from "../mcp/catalog.js";
import { createToolDiscoveryTools, type ToolRecallState } from "../mcp/tool-discovery.js";
import { detectDescriptionLanguage, type DescriptionLanguage } from "../mcp/retrieval.js";

export interface SalesAgentToolDeps {
	db: DatabaseSync;
	tenantId: string;
	store: SessionStore;
	/** 宿主运行轨迹句柄:工作流步骤事件写入此处当前绑定的 recorder(由 agent 运行时在每次运行前赋值)。 */
	traceHolder?: { recorder?: TimelineRecorder };
	/** 双语召回状态:本函数写入 catalog 信息,宿主写入 bilingual 改写结果(见 ToolRecallState) */
	recallState?: ToolRecallState;
}

// tools / tools_system 目录(仓库根),业务工具实现全部在目录内(main.ts + readme.json)
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TOOL_PATHS = TOOL_ROOTS.map((r) => path.join(repoRoot, r));


/** 系统收口工具:执行计划(规划阶段输出,前端展示规划结果)。 */
export function systemPlanTool(opts: { terminate?: boolean } = {}): AgentTool<any, any> {
	return {
		name: "emit_plan",
		label: "输出执行计划",
		description: "决定任务是否需要执行计划并输出:简单任务(单步查询/直接回答)选择 mode=none 直接执行,不写 steps;复杂任务(多步骤/多数据源/需拆解)选择 mode=single 输出 steps 计划;需要并行拆分的选 mode=multi 输出 subtasks。规划阶段只能调用本工具,调用后规划阶段结束。",
		parameters: Type.Object({
			summary: Type.Optional(Type.String({ description: "规划总览一句话" })),
			mode: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("single"), Type.Literal("multi")], { description: "执行模式:none=无需计划直接执行(仅简单任务);single=单代理按步骤执行;multi=多代理并行(任务可并行拆分/数据量大/需多路独立取数时用 multi)" })),
			steps: Type.Optional(
				Type.Array(
					Type.Object({
						step: Type.String({ description: "步骤说明" }),
						tool: Type.String({ description: "拟调用工具名(无则填空)" }),
						purpose: Type.String({ description: "预期产出/目的" }),
					}),
					{ minItems: 1 },
				),
			),
			subtasks: Type.Optional(
				Type.Array(
					Type.Object({
						title: Type.String({ description: "子任务标题" }),
						goal: Type.String({ description: "子代理要完成的目标(独立可并行)" }),
						tools: Type.Optional(Type.Array(Type.String(), { description: "子代理可用工具白名单(缺省只读工具)" })),
						shareOutput: Type.Optional(Type.Boolean({ description: "是否允许本子任务看到其他子任务的最新输出结果(默认 false)。用于需要参考前面子代理结论的后续任务;若子任务间应独立隔离,保持 false。" })),
					}),
					{ description: "multi 模式下的子任务清单" },
				),
			),
		}),
		async execute(_id, params: any) {
			const mode = params.mode === "none" ? "none" : params.mode === "multi" ? "multi" : "single";
			return {
				content: [{ type: "text" as const, text: mode === "none" ? "无需计划,直接执行" : mode === "multi" ? `多代理 ${(params.subtasks ?? []).length} 个子任务` : `${(params.steps ?? []).length} 步` }],
				details: { summary: params.summary, mode, steps: params.steps ?? [], subtasks: params.subtasks ?? [] },
				terminate: opts.terminate ?? true,
			};
		},
	};
}

/** 规划阶段工具集:仅 emit_plan(先规划不执行,避免规划阶段产生副作用)。 */
export function createPlanTools(): Array<AgentTool<any, any>> {
	return [systemPlanTool()];
}
/** 系统收口工具:最终答复(不随 tools 目录加载)。 */
export function systemFinalTool(): AgentTool<any, any> {
	return {
		name: "emit_final",
		label: "输出最终结论",
		description: "输出面向用户/销售的最终答复。完成目标后必须调用此工具并立即停止。",
		parameters: Type.Object({
			answer: Type.String({ description: "给用户的自然语言答复,允许分点与列表,但禁止包含任何 Markdown 表格(表格由工具返回,前端原样渲染)" }),
			summary: Type.Optional(Type.String({ description: "一句话摘要" })),
			nextSteps: Type.Optional(Type.Array(Type.String())),
		}),
		async execute(_id, params: any) {
			return {
				content: [{ type: "text" as const, text: params.answer }],
				details: { answer: params.answer, summary: params.summary, nextSteps: params.nextSteps ?? [] },
				terminate: true,
			};
		},
	};
}

/**
 * 从 tools / tools_system 目录动态加载全部业务工具(契约:readme.json + main.ts 导出 execute(ctx, params)),
 * 附加系统收口工具 emit_final。目录内新增/修改工具后重启服务即生效。
 */
/** 从工作流步骤参数中提取 {{param.x}} 占位符,生成工具参数 schema(占位符解析与 workflow-steps 同源)。 */
function workflowParamSchema(steps: unknown[]): Record<string, unknown> {
	const props: Record<string, { type: string; description: string }> = {};
	for (const st of steps || []) {
		for (const expr of collectPlaceholders((st as { params?: unknown }).params ?? {})) {
			if (!expr.startsWith("param.")) continue;
			const name = expr.slice(6);
			props[name] = { type: "string", description: name };
		}
	}
	return { type: "object", properties: props, required: Object.keys(props) };
}

/**
 * 把已晋升(status=enabled)的工作流注册为可调用工具:模型通过 tools 字段看到并直接执行。
 * traceHolder 指向宿主当前运行的 recorder,让步骤事件并入宿主轨迹(可被挖掘与复盘看到)。
 */
function workflowTool(wf: WorkflowRecord, db: DatabaseSync, tenantId: string, traceHolder: { recorder?: TimelineRecorder }): AgentTool<any, any> & { descriptionLanguage?: DescriptionLanguage } {
	const schema = workflowParamSchema(Array.isArray(wf.steps) ? wf.steps : []);
	const paramNames = Object.keys((schema.properties as Record<string, unknown>) ?? {});
	// 工作流描述默认中文(挖掘链路产出中文名/描述,人工在中文界面手建也多为中文):
	// 它按 description_language=zh 参与"中文 query"那一路召回;若某个工作流写成英文,这里自动判成 en,走英文那一路。
	return {
		name: workflowToolName(wf.id),
		label: "工作流:" + wf.name,
		descriptionLanguage: detectDescriptionLanguage(`${wf.name} ${wf.description ?? ""}`),
		description: `执行已沉淀的工作流「${wf.name}」:${wf.description || wf.name}${paramNames.length ? ` 可传参数:${paramNames.join("/")}` : ""}。调用后会按步骤执行并返回每步结果。`,
		parameters: Type.Object(schema.properties as never, { description: wf.name + " 的工作流参数" }),
		async execute(_id, params: any) {
			const outcome = await runWorkflowEngine({ db, tenantId, workflow: wf, params: params ?? {}, recorder: traceHolder.recorder });
			const lines = outcome.steps.map((st) => `${st.ok ? "OK" : "FAIL"} ${st.name}(${st.tool}): ${st.summary || st.error || ""}`);
			return {
				content: [{ type: "text" as const, text: `工作流「${wf.name}」执行${outcome.run.status}:
${lines.join("\n")}` }],
				details: { run: outcome.run, steps: outcome.steps },
			};
		},
	};
}

export interface SalesAgentToolOptions {
	/** 只挂载指定分类的工具(场景分组);缺省全量 */
	toolsets?: string[];
	/** 只挂载指定来源的工作流:manual=人工/接口预定义,mined=模型轨迹挖掘;缺省全部 */
	workflowOrigins?: Array<"manual" | "mined">;
}

export async function createSalesAgentTools(deps: SalesAgentToolDeps, opts: SalesAgentToolOptions = {}): Promise<Array<AgentTool<any, any>>> {
	// check_fn 环境门槛:web_search/web 依赖配置的 Serper 密钥,未配置则自动隐藏
	const external = await loadExternalAgentTools(TOOL_PATHS, { db: deps.db, tenantId: deps.tenantId, webSearchApiKey: config.webSearchApiKey });
	// 场景分组:按 readme 的 category 过滤,只挂载指定分类工具(模型上下文只看需要的工具)
	const filteredExternal = opts.toolsets?.length ? external.filter((t) => opts.toolsets!.includes((t as unknown as { category?: string }).category ?? "")) : external;
	const workflows = listWorkflows(deps.db, deps.tenantId).filter((w) => w.status === "enabled");
	const scoped = opts.workflowOrigins?.length ? workflows.filter((w) => opts.workflowOrigins!.includes(w.origin)) : workflows;
	const traceHolder = deps.traceHolder ?? {};
	// 步骤工具存在性校验:引用了未加载工具的工作流不挂载(否则模型一调就在该步失败),问题写日志暴露
	const workflowTools: Array<AgentTool<any, any>> = [];
	if (scoped.length > 0) {
		const knownStepTools = await loadStepToolNames(deps.tenantId);
		for (const w of scoped) {
			const check = checkWorkflowSteps((Array.isArray(w.steps) ? w.steps : []) as WorkflowStep[], knownStepTools);
			if (!check.ok) {
				console.warn(`[workflows] 「${w.name}」未挂载: ${check.issues.map((i) => i.message).join("; ")}`);
				continue;
			}
			workflowTools.push(workflowTool(w, deps.db, deps.tenantId, traceHolder));
		}
	}
	// MCP 客户端:接入配置的外部 MCP Server,把它们的工具混进 agent 工具列表(带 mcp_{server}_ 前缀)
	const mcpTools: AgentTool<any, any>[] = [];
	// 测试环境(vitest)不连外部 MCP:它是网络依赖,握手延迟/抖动会拖慢甚至拖垮用例;
	// 生产/开发环境照常接入,失败只告警不影响本地工具。
	const mcpServers = process.env.VITEST ? [] : config.mcpServers;
	for (const srv of mcpServers) {
		try {
			const client = new McpClient(srv);
			const remote = await client.listTools();
			for (const t of remote) mcpTools.push(mcpToolToAgentTool(srv.name, t, client));
		} catch (error) {
			console.warn(`[mcp-client] 接入 ${srv.name} 失败: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	// 把工作流工具名注册进动态展示名缓存(供前端进度条/时间线显示「工作流:xxx」)
	registerDynamicLabels(workflowTools.map((t) => ({ name: t.name, label: t.label })));

	// 工具编目:长尾工具(MCP + 工作流)超过阈值时不再直挂,改为三层按需加载
	// search_tools(编目,只给名字+一行描述) → get_tool_details(取单个工具 schema) → call_tool(执行)
	const longTail = [...mcpTools, ...workflowTools];
	// 短路条件(工具少):全部直挂,不做编目、不触发 query 改写
	if (!(config.toolsCatalogEnabled && longTail.length > config.toolsCatalogThreshold)) {
		if (deps.recallState) deps.recallState.catalog = { active: false, toolCount: filteredExternal.length + longTail.length };
		return [...filteredExternal, ...longTail, systemFinalTool()];
	}
	// 进编目:长尾工具(MCP + 工作流)总数超过阈值 —— 宿主据此决定是否触发双语 query 改写
	if (deps.recallState) deps.recallState.catalog = { active: true, toolCount: filteredExternal.length + longTail.length };
	// 检索通道:词面(BM25)+ 语义(BGE 向量)RRF 融合;各语言召回条数与 RRF 的 k 都来自配置
	const catalog = new ToolCatalog({
		semanticFloors: { zh: config.toolsCatalogSemanticFloorZh, en: config.toolsCatalogSemanticFloorEn },
		perLanguageTopK: config.toolsCatalogPerLanguageTopK,
	});
	// 条目带上描述语言:zh query 只召回中文描述的工具(mcp_ 工具是英文的,工作流多为中文)
	const toEntry = (tool: AgentTool<any, any>, origin: CatalogEntry["origin"]): CatalogEntry => ({
		name: tool.name,
		label: tool.label,
		description: String(tool.description ?? ""),
		descriptionLanguage: (tool as { descriptionLanguage?: DescriptionLanguage }).descriptionLanguage ?? detectDescriptionLanguage(String(tool.description ?? "")),
		origin,
		parameters: tool.parameters,
		execute: (toolCallId, params) => Promise.resolve(tool.execute(toolCallId, params)),
	});
	catalog.addMany(mcpTools.map((t) => toEntry(t, "mcp")));
	catalog.addMany(workflowTools.map((t) => toEntry(t, "workflow")));
	const discoveryTools = createToolDiscoveryTools(catalog, { topK: config.toolsCatalogTopK, maxInspect: config.toolsCatalogMaxInspect }, deps.recallState);	registerDynamicLabels(discoveryTools.map((t) => ({ name: t.name, label: t.label ?? t.name })));
	return [...filteredExternal, ...discoveryTools, systemFinalTool()];
}
