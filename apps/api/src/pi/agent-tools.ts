import { Type } from "typebox";
import type { DatabaseSync } from "node:sqlite";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { getCustomer, listCustomers, upsertCustomer } from "../repositories/customers.js";
import { searchKnowledge } from "../repositories/knowledge.js";
import { listAnalysesByCustomer } from "../repositories/analyses.js";
import { listCustomerTags } from "../repositories/customer-tags.js";
import { getConversation, listConversations } from "../repositories/conversations.js";
import { searchVehicles } from "../repositories/vehicles.js";
import { createTask, listTasks, setTaskStatus } from "../repositories/tasks.js";
import { approveCandidate, listCandidates, rejectCandidate } from "../repositories/knowledge-candidates.js";
import { ingestEntries } from "../services/ingest.js";
import { collectInsights } from "../services/insights.js";
import { collectDigest, formatDigest } from "../services/digest.js";
import { buildConversationText } from "./sessions.js";
import { fetchTranscript, type SessionStore } from "./sessions.js";
import { listConversationMessages, withToolCache } from "../repositories/conversation-data.js";

export interface SalesAgentToolDeps {
	db: DatabaseSync;
	tenantId: string;
	store: SessionStore;
	searchLimit?: number;
}

const text = (content: string, details?: unknown) => ({ content: [{ type: "text" as const, text: content }], details });

export function createSalesAgentTools(deps: SalesAgentToolDeps): Array<AgentTool<any, any>> {
	const { db, tenantId, store, searchLimit = 5 } = deps;

	const resolveCustomer = (customerKey: string) => {
		let row = getCustomer(db, tenantId, customerKey);
		if (!row) row = upsertCustomer(db, { tenantId, key: customerKey });
		return row;
	};

	return [
		{
			name: "search_playbook",
			label: "检索话术库",
			description: "在团队知识库检索话术、竞品资料、价格政策、售后FAQ。优先用客户原话或具体词(产品名、价格数字、功能名),无命中时如实说明。",
			parameters: Type.Object({
				query: Type.String({ description: "检索关键词" }),
				limit: Type.Optional(Type.Number({ default: 5, minimum: 1, maximum: 10 })),
			}),
			async execute(_id, params: any) {
				return withToolCache(db, tenantId, "search_playbook", params, () => {
					const hits = searchKnowledge(db, tenantId, params.query, params.limit ?? searchLimit);
				return text(
					hits.length
						? hits.map((h) => `【${h.title}】${h.category ? `(${h.category})` : ""}\n${h.snippet}`).join("\n\n")
						: "知识库未命中。",
					hits,
				);

				});			},
		},
		{
			name: "list_customers",
			label: "列出客户",
			description: "列出当前租户全部客户(标识/姓名/电话/阶段/最近分析时间/会话数),直接返回完整清单表格,内容可原样展示;查询客户概况时优先使用。",
			parameters: Type.Object({
				limit: Type.Optional(Type.Number({ default: 50, minimum: 1, maximum: 100 })),
			}),
			async execute(_id, params: any) {
				const rows = listCustomers(db, tenantId, params.limit ?? 50);
				if (!rows.length) return text("暂无客户档案。", rows);
				const lines = ["| 客户标识 | 姓名 | 电话 | 阶段 | 最近分析 | 会话数 |", "| --- | --- | --- | --- | --- | --- |"];
				for (const r of rows) {
					lines.push(`| ${r.key} | ${r.name ?? "—"} | ${r.phone ?? "—"} | ${r.stage ?? "—"} | ${r.lastAnalysisAt?.slice(0, 10) ?? "—"} | ${r.conversationCount} |`);
				}
				return text(`当前客户清单(${rows.length} 位):\n${lines.join("\n")}`, { customers: rows });
			},
		},		{
			name: "get_customer_profile",
			label: "查看客户档案",
			description: "按客户 key 获取客户资料(名称/公司/阶段/备注)。",
			parameters: Type.Object({ customerKey: Type.String({ description: "客户标识,如 c_001" }) }),
			async execute(_id, params: any) {
				return withToolCache(db, tenantId, "get_customer_profile", params, () => {
					const row = resolveCustomer(params.customerKey);
				return text(
					`客户:${row.name ?? params.customerKey}${row.company ? ` / ${row.company}` : ""}\n阶段:${row.stage ?? "未知"}\n备注:${row.notes ?? "无"}`,
					row,
				);

				});			},
		},
		{
			name: "get_customer_history",
			label: "查看客户历史分析",
			description: "查看客户最近若干次分析结论,供回顾或延续上下文。",
			parameters: Type.Object({
				customerKey: Type.String({ description: "客户标识" }),
				limit: Type.Optional(Type.Number({ default: 5, maximum: 20 })),
			}),
			async execute(_id, params: any) {
				const row = resolveCustomer(params.customerKey);
				const items = listAnalysesByCustomer(db, tenantId, row.id, params.limit ?? 5);
				return text(
					items.length
						? items.map((a) => `[${a.createdAt.slice(0, 10)}] ${a.intent}: ${a.summary}`).join("\n")
						: "该客户暂无历史分析。",
					items,
				);
			},
		},
		{
			name: "get_customer_tags",
			label: "查看客户标签",
			description: "查看系统自动沉淀的客户标签(如价格敏感、竞品对比)。",
			parameters: Type.Object({ customerKey: Type.String({ description: "客户标识" }) }),
			async execute(_id, params: any) {
				const row = resolveCustomer(params.customerKey);
				const tags = listCustomerTags(db, tenantId, row.id);
				return text(tags.length ? tags.map((t) => `${t.tag} ×${t.weight}`).join("、") : "暂无标签。", tags);
			},
		},
		{
			name: "list_conversations",
			label: "列出来库会话",
			description: "列出最近的会话(时间/ID/销售/客户/消息数),便于定位需要分析的会话。",
			parameters: Type.Object({ limit: Type.Optional(Type.Number({ default: 20, maximum: 50 })) }),
			async execute(_id, params: any) {
				const list = listConversations(db, tenantId, params.limit ?? 20);
				return text(
					list.length
						? list.map((c) => `${c.id.slice(0, 10)}… ${c.customerName ?? c.customerKey ?? "未知客户"} | 销售:${c.salesName} | ${c.messageCount}条 | ${c.createdAt}`).join("\n")
						: "暂无会话。",
					list,
				);
			},
		},
		{
			name: "load_conversation",
			label: "读取会话原文",
			description: "按会话 ID 读取完整对话原文(客户/销售交替),供分析使用。",
			parameters: Type.Object({ conversationId: Type.String({ description: "会话 ID" }) }),
			async execute(_id, params: any) {
				const meta = getConversation(db, tenantId, params.conversationId);
				if (!meta) return text("未找到该会话。");
				const rows = listConversationMessages(db, tenantId, params.conversationId);
				if (rows.length > 0) {
					const messages = rows.map((m) => ({ seq: m.seq, speakerRole: m.speaker_role, speakerName: m.speaker_name, content: m.content, spokenAt: m.spoken_at }));
					const lines = messages.map((m) => `${m.spokenAt ?? ""}\t[${m.speakerRole === "customer" ? "客户" : m.speakerRole === "sales" ? "销售" : "其他"}${m.speakerName ? `:${m.speakerName}` : ""}]\t${m.content}`).join("\n");
					return text(`会话 ${meta.id.slice(0, 10)}… 原文:\n${lines}`, { conversationId: meta.id, messages });
				}
				const session = await store.openConversation(meta.id);
				const transcript = await fetchTranscript(session);
				if (transcript.length === 0) return text("会话为空。");
				const content = buildConversationText(transcript);
				return text(`会话 ${meta.id.slice(0, 10)}… 原文:\n${content}`, { conversationId: meta.id, messages: transcript });
			},
		},
		{
			name: "search_vehicles",
			label: "查车型库",
			description: "按预算/座位/能源/关键词查车型库,返回匹配车型及价格区间。",
			parameters: Type.Object({
				budgetMin: Type.Optional(Type.Number()),
				budgetMax: Type.Optional(Type.Number()),
				seats: Type.Optional(Type.Number()),
				energyType: Type.Optional(Type.String()),
				keyword: Type.Optional(Type.String()),
				limit: Type.Optional(Type.Number({ default: 10, maximum: 20 })),
			}),
			async execute(_id, params: any) {
				return withToolCache(db, tenantId, "search_vehicles", params, () => {
					const rows = searchVehicles(db, {
						tenantId,
						budgetMin: params.budgetMin,
						budgetMax: params.budgetMax,
						seats: params.seats,
						energyType: params.energyType,
						keyword: params.keyword,
						limit: params.limit ?? 10,
					});
				return text(
					rows.length
						? rows.map((v) => `${v.brand} ${v.series} ${v.modelName} | ${v.priceMin}-${v.priceMax}万 | ${v.energyType}/${v.bodyType}/${v.seats}座 | ${v.highlights ?? ""}`).join("\n")
						: "没有匹配车型。",
					rows,
				);

				});			},
		},
		{
			name: "list_tasks",
			label: "查看跟进任务",
			description: "查看待办或已完成的跟进任务。",
			parameters: Type.Object({
				status: Type.Optional(Type.String({ description: "pending 或 done" })),
				limit: Type.Optional(Type.Number({ default: 20, maximum: 50 })),
			}),
			async execute(_id, params: any) {
				const rows = listTasks(db, { tenantId, status: (params.status === "done" ? "done" : "pending") as "done" | "pending", limit: params.limit ?? 20 });
				return text(
					rows.length ? rows.map((t) => `${t.customerName ?? t.customerKey ?? "未知"} | ${t.action} | ${t.dueAt ?? "无期限"} | ${t.status}`).join("\n") : "暂无任务。",
					rows,
				);
			},
		},
		{
			name: "create_task",
			label: "创建跟进任务",
			description: "为客户创建跟进待办(如回访、报价、试驾邀约)。",
			parameters: Type.Object({
				customerKey: Type.String({ description: "客户标识" }),
				action: Type.String({ description: "跟进动作,一句话描述" }),
				dueAt: Type.Optional(Type.String({ description: "到期时间 ISO 8601" })),
			}),
			async execute(_id, params: any) {
				const row = resolveCustomer(params.customerKey);
				const task = createTask(db, { tenantId, customerId: row.id, action: params.action, dueAt: params.dueAt });
				return text(`已创建任务:${task.action}`, task);
			},
		},
		{
			name: "complete_task",
			label: "完成跟进任务",
			description: "把某个跟进任务标记为已完成。",
			parameters: Type.Object({ taskId: Type.String({ description: "任务 ID" }) }),
			async execute(_id, params: any) {
				const task = setTaskStatus(db, tenantId, params.taskId, "done");
				return text(task ? `已完成任务:${task.action}` : "未找到该任务。", task);
			},
		},
		{
			name: "ingest_knowledge",
			label: "沉淀知识点",
			description: "把话术/政策/竞品资料写入知识库(可指定分类与多条)。",
			parameters: Type.Object({
				category: Type.Optional(Type.String()),
				entries: Type.Array(Type.Object({ title: Type.String(), content: Type.String() }), { minItems: 1 }),
			}),
			async execute(_id, params: any) {
				const results = ingestEntries(db, { tenantId, category: params.category, entries: params.entries });
				const added = results.filter((r) => !r.skipped).length;
				return text(`沉淀完成:新增 ${added} 条,跳过 ${results.length - added} 条。`, results);
			},
		},
		{
			name: "list_knowledge_candidates",
			label: "查看待沉淀候选",
			description: "查看系统从历史会话自动抽取、待确认入库的知识候选。",
			parameters: Type.Object({ limit: Type.Optional(Type.Number({ default: 20, maximum: 50 })) }),
			async execute(_id, params: any) {
				const items = listCandidates(db, tenantId, "pending", params.limit ?? 20);
				return text(
					items.length ? items.map((c) => `${c.id.slice(0, 10)}… [${c.intent}] ${c.draftTitle}: ${c.draftContent.slice(0, 120)}`).join("\n") : "暂无待沉淀候选。",
					items,
				);
			},
		},
		{
			name: "approve_knowledge_candidate",
			label: "确认知识候选",
			description: "把知识候选确认入库。",
			parameters: Type.Object({ candidateId: Type.String() }),
			async execute(_id, params: any) {
				const c = approveCandidate(db, tenantId, params.candidateId);
				return text(c ? `已入库:${c.draftTitle}` : "未找到候选。", c);
			},
		},
		{
			name: "reject_knowledge_candidate",
			label: "拒绝知识候选",
			description: "拒绝某个知识候选。",
			parameters: Type.Object({ candidateId: Type.String() }),
			async execute(_id, params: any) {
				const c = rejectCandidate(db, tenantId, params.candidateId);
				return text(c ? `已拒绝:${c.draftTitle}` : "未找到候选。", c);
			},
		},
		{
			name: "collect_insights",
			label: "经营洞察",
			description: "统计近 N 天分析量、热门意图、任务完成率、车型偏好。",
			parameters: Type.Object({ days: Type.Optional(Type.Number({ default: 7 })) }),
			async execute(_id, params: any) {
				const r = collectInsights(db, { tenantId, days: params.days ?? 7 });
				return text(
					`近${r.days}天:分析 ${r.analyses} 次 / 待办 ${r.pendingTasks} / 到期 ${r.overdueTasks} / 完成率 ${Math.round(r.taskCompletionRate * 100)}%\n热门意图:${(r.topIntents || []).map((i) => `${i.intent}×${i.count}`).join("、") || "无"}\n热门品牌:${(r.topBrands || []).map((b) => `${b.brand}×${b.count}`).join("、") || "无"}`,
					r,
				);
			},
		},
		{
			name: "build_morning_digest",
			label: "生成晨报",
			description: "生成本日晨报:待办/到期任务、关键跟进客户、近24h分析数。",
			parameters: Type.Object({}),
			async execute() {
				const d = collectDigest(db, { tenantId });
				return text(formatDigest(d.stats), d);
			},
		},
		{
			name: "emit_final",
			label: "输出最终答复",
			description: "输出面向用户/销售的最终答复。完成目标后必须调用此工具并立即停止。",
			parameters: Type.Object({
				answer: Type.String({ description: "给用户的自然语言答复,可包含分点建议" }),
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
		},
	];
}
