/**
 * 一次性抓取:把 MCP server 的工具清单(name / description / inputSchema)落成固定语料,
 * 让评测不依赖网络与远端可用性。用法: npx tsx opimize/catalog/fixtures/capture-mcp-snapshot.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { config } from "../../../backend/env.ts";
import { McpClient } from "../../../backend/mcp/client.ts";

const out = [];
for (const server of config.mcpServers) {
	const client = new McpClient(server);
	const tools = await client.listToolsFresh();
	for (const t of tools) out.push({ server: server.name, name: `mcp_${server.name}_${t.name}`.replace(/[^a-zA-Z0-9_-]/g, "_"), description: t.description ?? "", inputSchema: t.inputSchema ?? null });
	console.log(`${server.name}: ${tools.length} 个工具`);
}
mkdirSync(new URL("./", import.meta.url), { recursive: true });
writeFileSync(new URL("./mcp-tools.json", import.meta.url), JSON.stringify(out, null, 2), "utf8");
console.log(`已写入 fixtures/mcp-tools.json,共 ${out.length} 个工具`);
