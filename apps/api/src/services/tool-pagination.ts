import { externalToolByName, externalToolPaths, type ExternalToolContext } from "./external-tools.js";

/** 允许前端手动翻页的表格类工具白名单(防止任意工具被客户端直接执行)。 */
export const PAGINATED_TOOLS: ReadonlySet<string> = new Set(["customer_query", "conversation_query", "vehicle_query", "excel", "table_generate"]);

export interface ToolPageResult {
	name: string;
	content: Array<{ type: "text"; text: string }>;
	details: unknown;
}

/**
 * 手动翻页:只允许白名单表格工具,参数必须是 page 正整数;直接执行工具并返回原始结果,
 * 不经过大模型,保证翻页展示的就是工具原文。
 */
export async function executeToolPage(ctx: ExternalToolContext, name: string, params: Record<string, unknown>): Promise<ToolPageResult> {
	if (!PAGINATED_TOOLS.has(name)) throw new Error(`工具 ${name} 不支持手动翻页`);
	const page = Number(params?.page ?? 1);
	if (!Number.isInteger(page) || page < 1) throw new Error("page 必须是正整数");
	const tool = await externalToolByName(externalToolPaths(), ctx, name);
	const result = await tool.execute(`page-${page}`, { ...(params ?? {}), page });
	return { name, content: result.content as never, details: result.details };
}