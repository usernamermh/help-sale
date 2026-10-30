/**
 * 外部 MCP 工具列表的后台预热:服务启动时先拉一次,之后在缓存过期前静默续期。
 * 这样"每 5 分钟一次 20 秒的握手"不会落在用户消息的等待路径上。
 */
import { MCP_TOOLS_TTL_MS, refreshMcpTools, type McpServerConfig } from "./client.js";

/** 提前量:在缓存到期前 60 秒刷新,避免刚好卡在过期点。 */
const REFRESH_LEAD_MS = 60_000;

export function startMcpToolWarmup(servers: McpServerConfig[]): () => void {
	if (servers.length === 0) return () => undefined;
	if (process.env.VITEST) return () => undefined; // 测试不连外部网络
	let stopped = false;

	const refresh = async (first: boolean): Promise<void> => {
		if (stopped) return;
		const startedAt = Date.now();
		const result = await refreshMcpTools(servers);
		if (first || result.failed.length > 0) {
			console.log(`[mcp] 工具列表${first ? "预热" : "续期"}完成:成功 ${result.ok.length} 个(${result.ok.join(",") || "无"}),失败 ${result.failed.length} 个,耗时 ${Date.now() - startedAt}ms`);
		}
	};

	void refresh(true);
	const timer = setInterval(() => void refresh(false), Math.max(30_000, MCP_TOOLS_TTL_MS - REFRESH_LEAD_MS));
	timer.unref?.();
	return () => {
		stopped = true;
		clearInterval(timer);
	};
}