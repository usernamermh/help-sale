export interface CapabilityDef {
	name: string;
	label: string;
	description: string;
	category: string;
}

// 与 pi/agent-tools.ts 中的工具一一对应(不含系统收口工具 emit_final)
export const CAPABILITIES: CapabilityDef[] = [
	{ name: "list_customers", label: "列出客户", description: "列出客户清单(标识/姓名/电话/阶段/最近分析/会话数)", category: "客户" },
	{ name: "get_customer_profile", label: "查询客户档案", description: "查客户名称/公司/阶段/备注", category: "客户" },
	{ name: "get_customer_history", label: "查询客户历史", description: "查客户最近若干次分析结论", category: "客户" },
	{ name: "get_customer_tags", label: "查询客户标签", description: "查系统自动沉淀的客户标签", category: "客户" },
	{ name: "list_conversations", label: "列出会话", description: "列出最近的会话", category: "会话" },
	{ name: "load_conversation", label: "读取会话原文", description: "按 ID 读取完整对话原文", category: "会话" },
	{ name: "search_playbook", label: "检索话术", description: "在知识库检索话术/政策/FAQ", category: "知识" },
	{ name: "ingest_knowledge", label: "沉淀话术知识", description: "把话术/政策写入知识库", category: "知识" },
	{ name: "list_knowledge_candidates", label: "查看知识候选", description: "查看待确认入库的知识候选", category: "知识" },
	{ name: "approve_knowledge_candidate", label: "确认知识候选", description: "把候选确认入库", category: "知识" },
	{ name: "reject_knowledge_candidate", label: "拒绝知识候选", description: "拒绝某个候选", category: "知识" },
	{ name: "search_vehicles", label: "检索车型", description: "按预算/座位/能源查车型库", category: "车型" },
	{ name: "list_tasks", label: "查看任务", description: "查看待办或已完成任务", category: "任务" },
	{ name: "create_task", label: "创建任务", description: "为客户创建跟进待办", category: "任务" },
	{ name: "complete_task", label: "完成任务", description: "把任务标记为已完成", category: "任务" },
	{ name: "collect_insights", label: "收集经营洞察", description: "统计分析量/意图/任务完成率", category: "经营" },
	{ name: "build_morning_digest", label: "生成晨报", description: "生成本日待办与跟进晨报", category: "经营" },
	{ name: "todo_list", label: "待办清单", description: "创建/细化/标记完成 todo list(tools_system)", category: "流程" },
];

export function capabilitiesFor(category?: string): CapabilityDef[] {
	return category ? CAPABILITIES.filter((c) => c.category === category) : CAPABILITIES;
}

export function getCapabilityDef(name: string): CapabilityDef | undefined {
	return CAPABILITIES.find((c) => c.name === name);
}

// 系统收口工具等不在能力清单里的展示名
const EXTRA_TOOL_LABELS: Record<string, string> = {
	emit_final: "输出最终结论",
};

export function toolLabel(name: string | undefined): string {
	if (!name) return "未知工具";
	const def = getCapabilityDef(name);
	if (def) return def.label;
	return EXTRA_TOOL_LABELS[name] ?? name;
}