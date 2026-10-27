import { config } from "../../backend/env.js";
import { mineToolChains, refineChainToWorkflow, validateRefinedWorkflow } from "../../backend/services/routes/workflows.js";
import { checkWorkflowSteps, loadStepToolNames, stepsSignature } from "../../backend/services/routes/workflows.js";
import {
	approveWorkflow,
	createWorkflow,
	findWorkflowBySignature,
	listWorkflows,
	rejectWorkflow,
	setWorkflowStatus,
	getWorkflow,
} from "../../backend/integrations_pi/tables/agents/capabilities.js";

interface ToolContext { db: any; tenantId: string; }

/**
 * 工作流沉淀管理:把「模型执行轨迹 → 可复用固定工作流」这条链路交给模型按用户指令自主触发。
 * op=mine    挖掘高频工具串联 → LLM 提炼 → 工具存在性校验 → 签名去重 → 落草稿
 * op=list    列出工作流(默认只看待审批草稿),标注来源(模型挖掘/人工预定义)与建议
 * op=approve 晋升草稿为可调用工作流(用户明确同意时执行)
 * op=reject  驳回草稿(保留定义,不再重复产出)
 * op=disable 停用/启用一个已晋升的工作流
 * op=check   静态自检:步骤工具是否存在 + 占位符引用是否成立
 */
export async function execute(ctx: ToolContext, params: any) {
	const op = String(params?.op ?? "mine");
	const db = ctx.db;
	const tenantId = ctx.tenantId;

	if (op === "list") {
		const status = params?.status ? String(params.status) : "draft";
		const origin = params?.origin ? String(params.origin) : "";
		const limit = Math.max(1, Math.min(Number(params?.limit ?? 30) || 30, 100));
		const all = listWorkflows(db, tenantId).filter((w) => (!status || status === "all" || w.status === status) && (!origin || w.origin === origin));
		const items = all.slice(0, limit);
		if (!items.length) return { content: [{ type: "text", text: `暂无工作流(status=${status || "all"}, origin=${origin || "all"})。` }], details: { workflows: [] } };
		return {
			content: [{ type: "text", text: items.map((w) => `${w.id.slice(0, 10)}… [${w.origin === "mined" ? "模型挖掘" : "人工预定义"}] ${w.name}(status:${w.status}, v${w.version}, ${w.steps.length}步)${w.sourceSignature ? ` 签名:${w.sourceSignature}` : ""}`).join("\n") }],
			details: { workflows: items, total: all.length },
		};
	}

	if (op === "approve") {
		const wf = approveWorkflow(db, tenantId, String(params?.workflowId ?? ""));
		if (!wf) return { content: [{ type: "text", text: "未找到该工作流。" }], details: null };
		const check = checkWorkflowSteps((wf.steps ?? []) as never, await loadStepToolNames(tenantId));
		return {
			content: [{ type: "text", text: check.ok ? `已晋升为可调用工作流「${wf.name}」(${wf.steps.length} 步,来源:${wf.origin === "mined" ? "模型轨迹挖掘" : "人工预定义"})。` : `已标记为启用,但存在不可执行步骤,暂不会挂载给模型:${check.issues.map((i) => i.message).join(";")}` }],
			details: { workflow: wf, mountable: check.ok, issues: check.issues },
		};
	}

	if (op === "reject") {
		const wf = rejectWorkflow(db, tenantId, String(params?.workflowId ?? ""));
		return { content: [{ type: "text", text: wf ? `已驳回草稿「${wf.name}」:不再进入工具列表,同签名链路也不会重复挖掘产出。` : "未找到该工作流。" }], details: wf };
	}

	if (op === "disable") {
		const enabled = params?.enabled !== false;
		const wf = setWorkflowStatus(db, tenantId, String(params?.workflowId ?? ""), enabled ? "enabled" : "disabled");
		return { content: [{ type: "text", text: wf ? `已${enabled ? "启用" : "停用"}工作流「${wf.name}」。` : "未找到该工作流。" }], details: wf };
	}

	if (op === "check") {
		const wf = getWorkflow(db, tenantId, String(params?.workflowId ?? ""));
		if (!wf) return { content: [{ type: "text", text: "未找到该工作流。" }], details: null };
		const check = checkWorkflowSteps((wf.steps ?? []) as never, await loadStepToolNames(tenantId));
		return {
			content: [{ type: "text", text: check.ok ? `「${wf.name}」可执行:${wf.steps.length} 步全部命中已加载工具,占位符引用成立;需要参数 ${check.paramNames.length ? check.paramNames.join("/") : "(无)"}。` : `「${wf.name}」${check.issues.length} 处问题:${check.issues.map((i) => `[${i.stepName}] ${i.message}`).join(";")}` }],
			details: { workflow: wf, check },
		};
	}

	// 默认 op=mine
	const days = params?.days ? Number(params.days) : config.workflowMineDays;
	const refineTop = params?.refineTop != null ? Math.max(0, Math.trunc(Number(params.refineTop))) : config.workflowMineRefineTop;
	const chains = mineToolChains(db, tenantId, {
		days,
		minWindow: params?.minWindow ? Number(params.minWindow) : undefined,
		maxWindow: params?.maxWindow ? Number(params.maxWindow) : undefined,
		minCount: params?.minCount ? Number(params.minCount) : undefined,
		topChains: params?.topChains ? Number(params.topChains) : undefined,
	});
	if (!chains.length) {
		return {
			content: [{ type: "text", text: `近 ${days} 天没有发现可复用的高频工具串联(需要同一序列在至少 ${params?.minCount ?? config.workflowMineMinCount} 次独立运行中出现)。可扩大 days 或降低 minCount 再试。` }],
			details: { chains: [], created: [], skipped: [] },
		};
	}
	const knownTools = await loadStepToolNames(tenantId);
	const created: Array<unknown> = [];
	const skipped: Array<{ signature: string; count: number; reason: string }> = [];
	for (const c of chains.slice(0, refineTop)) {
		const existing = config.workflowMineDedupe ? findWorkflowBySignature(db, tenantId, c.signature) : undefined;
		if (existing) {
			skipped.push({ signature: c.signature, count: c.count, reason: `已存在「${existing.name}」(状态:${existing.status}),跳过` });
			continue;
		}
		try {
			const refined = await refineChainToWorkflow(c);
			const check = validateRefinedWorkflow(refined, c, knownTools);
			if (!check.ok) {
				skipped.push({ signature: c.signature, count: c.count, reason: `校验未通过:${check.errors.join(";")}` });
				continue;
			}
			const wf = createWorkflow(db, tenantId, {
				name: refined.name,
				description: refined.description,
				steps: check.steps,
				status: "draft",
				origin: "mined",
				sourceSignature: c.signature,
			});
			created.push({ id: wf.id, name: wf.name, signature: stepsSignature(check.steps as never), steps: check.steps.length, count: c.count });
		} catch (error) {
			skipped.push({ signature: c.signature, count: c.count, reason: `提炼失败:${error instanceof Error ? error.message : String(error)}` });
		}
	}
	const summary = `挖掘完成:发现 ${chains.length} 条高频串联,新产出 ${created.length} 个待审批草稿` + (skipped.length ? `,跳过 ${skipped.length} 条(${skipped.map((s) => `${s.signature}:${s.reason}`).join("；")})` : "") + "。草稿需用户确认后调 workflow_manage(op=approve) 晋升为可调用工作流。";
	return {
		content: [{ type: "text", text: summary }],
		details: { created, skipped, chains: chains.map((c) => ({ signature: c.signature, count: c.count })) },
	};
}