import { describe, expect, it } from "vitest";
import { ToolCatalog, summarize, type CatalogEntry } from "./catalog.js";
import { createToolDiscoveryTools } from "./tool-discovery.js";

function entry(name: string, description: string, executed: string[] = []): CatalogEntry {
	return {
		name,
		description,
		origin: "mcp",
		parameters: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] },
		execute: async () => {
			executed.push(name);
			return { content: [{ type: "text", text: `${name} ok` }], details: null };
		},
	};
}

/**
 * 词面通道的确定性测试替身:向量全零 → 余弦恒为 0 → 语义通道被 semanticFloor 全部挡掉,
 * 于是 search() 的行为等价于纯 BM25。语义通道与融合逻辑在 retrieval.test.ts 里单独验。
 * (不用真实 BGE:单测不该依赖模型文件与 worker 线程)
 */
function lexicalCatalog(semanticFloor = 0.5): ToolCatalog {
	return new ToolCatalog({ semanticFloors: { zh: semanticFloor, en: semanticFloor }, perLanguageTopK: 8, embed: async (texts: string[]) => texts.map(() => [0, 0]) });
}

/** 取工具结果里的文本(测试用:content 可能是文本或图片项) */
function textOf(result: { content: Array<unknown> }): string {
	return result.content.map((c) => (c as { text?: string }).text ?? "").join("\n");
}

describe("工具编目", () => {
	it("一行摘要会压平空白并截断", () => {
		expect(summarize("  a\n\nb  ")).toBe("a b");
		expect(summarize("x".repeat(200)).length).toBe(120);
	});

	it("检索按 名称命中 > 名称包含 > 描述命中 排序", async () => {
		const catalog = lexicalCatalog();
		catalog.addMany([
			entry("salesforce_updateRecord", "Update fields on an object"),
			entry("salesforce_upsertRecord", "Insert or update based on external id"),
			entry("github_create_issue", "Create a new issue in a repository"),
		]);
		expect((await catalog.search("salesforce_updateRecord", 3))[0].name).toBe("salesforce_updateRecord");
		expect((await catalog.search("upsert", 3))[0].name).toBe("salesforce_upsertRecord");
		expect((await catalog.search("创建 issue", 3))[0].name).toBe("github_create_issue");
		expect(await catalog.search("完全不相关的东西", 3)).toHaveLength(0);
	});

	it("编目结果只含名称与描述,不泄漏参数 schema", async () => {
		const catalog = lexicalCatalog();
		catalog.add(entry("github_create_issue", "Create a new issue in a repository"));
		const hits = await catalog.search("create issue", 5);
		expect(Object.keys(hits[0]).sort()).toEqual(["description", "name"]);
		expect(JSON.stringify(hits)).not.toContain("properties");
	});

	it("检查阶段才返回单个工具的完整参数", () => {
		const catalog = lexicalCatalog();
		catalog.add(entry("github_create_issue", "Create a new issue in a repository"));
		const detail = catalog.details("github_create_issue");
		expect(detail?.parameters).toMatchObject({ required: ["repo"] });
		expect(catalog.details("no_such_tool")).toBeUndefined();
	});

	it("执行阶段校验工具名,并转发到真实工具", async () => {
		const executed: string[] = [];
		const catalog = lexicalCatalog();
		catalog.add(entry("github_create_issue", "Create a new issue in a repository", executed));
		const result = await catalog.call("github_create_issue", { repo: "a/b" });
		expect(executed).toEqual(["github_create_issue"]);
		expect((result as { content: Array<{ text: string }> }).content[0].text).toContain("ok");
		await expect(catalog.call("no_such_tool", {})).rejects.toThrow(/不在可用工具清单/);
	});

	it("三层工具对模型暴露:search 只给摘要、details 给 schema、call 转执行", async () => {
		const catalog = lexicalCatalog();
		catalog.addMany([entry("mcp_github_create_issue", "Create a new issue in a repository"), entry("mcp_github_list_issues", "List issues in a repository")]);
		const [search, details, call] = createToolDiscoveryTools(catalog, { topK: 5, maxInspect: 2 });
		expect([search.name, details.name, call.name]).toEqual(["search_tools", "get_tool_details", "call_tool"]);

		const searched = await search.execute("t1", { query: "create issue" });
		expect(textOf(searched)).toContain("mcp_github_create_issue");
		expect(JSON.stringify(searched)).not.toContain("properties");

		const inspected = await details.execute("t2", { name: "mcp_github_create_issue" });
		expect(textOf(inspected)).toContain("properties");

		// 超出 maxInspect 后不再返回 schema
		const inspected2 = await details.execute("t3", { name: "mcp_github_list_issues" });
		expect(textOf(inspected2)).toContain("properties");
		const limited = await details.execute("t4", { name: "mcp_github_list_issues" });
		expect(limited.details).toMatchObject({ limited: true });
	});
});