import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadExternalAgentTools, buildExternalToolsText, scanExternalTools } from "./external-tools.js";

let root: string;
const dirs: string[] = [];
function makeTool(rel: string, json: unknown): string {
	const dir = path.join(root, rel);
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, "readme.json");
	fs.writeFileSync(file, JSON.stringify(json, null, 2), "utf8");
	return dir;
}
beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "ext-tools-"));
	dirs.push(root);
});
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("scanExternalTools", () => {
	it("扫描多个根目录,解析 readme.json 并排序", () => {
		const toolsDir = makeTool("tools_root/simple_tool", {
			name: "simple_tool",
			description: "一个示例工具\n第二行描述",
			function_list: ["main.run", "main.stop"],
		});
		const sysDir = makeTool("sys_root/alpha", { name: "alpha", description: "A 工具", function_list: [] });
		// 无 readme.json 的目录应被跳过;根目录下的散文件也应忽略
		fs.mkdirSync(path.join(toolsDir, "..", "no_readme"), { recursive: true });
		fs.writeFileSync(path.join(toolsDir, "..", "loose.mjs"), "export default 1", "utf8");

		const tools = scanExternalTools([path.dirname(toolsDir), path.dirname(sysDir)]);
		expect(tools.map((t) => t.name)).toEqual(["alpha", "simple_tool"]);
		const simple = tools.find((t) => t.name === "simple_tool")!;
		expect(simple.root).toBe("tools_root");
		expect(simple.description).toBe("一个示例工具\n第二行描述");
		expect(simple.functions).toEqual(["main.run", "main.stop"]);
	});

	it("只认 readme.json,不认 readme.md;损坏 JSON 跳过", () => {
		const rootDir = path.join(root, "mixed");
		fs.mkdirSync(path.join(rootDir, "md_only"), { recursive: true });
		fs.writeFileSync(path.join(rootDir, "md_only", "readme.md"), "old format", "utf8");
		fs.mkdirSync(path.join(rootDir, "bad_json"), { recursive: true });
		fs.writeFileSync(path.join(rootDir, "bad_json", "readme.json"), "{ not json", "utf8");

		expect(scanExternalTools([rootDir])).toEqual([]);
	});

	it("function_list 缺失时从 main.ts / main.py 提取", () => {
		const dir = makeTool("impl_tool", { name: "impl_tool", description: "x" });
		fs.writeFileSync(
			path.join(dir, "main.ts"),
			'export function create(input: string): string { return input; }\n/** b */\nexport async function finish(ids: string[]): Promise<void> {}\n',
			"utf8",
		);
		const tools = scanExternalTools([path.dirname(dir)]);
		expect(tools[0].functions).toEqual(["main.create", "main.finish"]);
	});

	it("tool 与 tools_system 混杂时保留来源根目录信息", () => {
		const a = makeTool("tools_a/p1", { name: "p1", description: "d", function_list: ["main.x"] });
		const b = makeTool("tools_b/p2", { name: "p2", description: "d", function_list: [] });
		const tools = scanExternalTools([path.dirname(a), path.dirname(b)]);
		expect(tools.find((t) => t.name === "p1")?.root).toBe("tools_a");
		expect(tools.find((t) => t.name === "p2")?.root).toBe("tools_b");
	});
});

describe("buildExternalToolsText", () => {
	it("生成 prompt 块:工具名/描述/函数", () => {
		const text = buildExternalToolsText([
			{ root: "tools_system", dir: "todo_list", name: "todo_list", description: "创建、细化、标记完成 todo list", functions: ["main.createTodoList", "main.finishTodoList"] },
			{ root: "tools", dir: "date_tool", name: "date_tool", description: "把周X转为年月日", functions: [] },
		]);
		expect(text).toContain("【外部工具】");
		expect(text).toContain("todo_list(tools_system/todo_list): 创建、细化、标记完成 todo list");
		expect(text).toContain("main.createTodoList");
		expect(text).toContain("date_tool");
	});

	it("空列表返回空串", () => {
		expect(buildExternalToolsText([])).toBe("");
	});
});

describe("tools_system 基础工具", () => {
	const SYS_ROOTS = ["E:\\proj_help_sale\\tools", "E:\\proj_help_sale\\tools_system"];
	async function loadAll() {
		return loadExternalAgentTools(SYS_ROOTS, { db: null, tenantId: "t1" } as never);
	}

	it("八个系统工具全部具备实现可加载", async () => {
		const tools = await loadAll();
		const names = tools.map((t) => t.name);
		for (const n of ["browser", "computer", "kanban", "redis", "sql", "subagents", "table_generate", "todo_list"]) {
			expect(names).toContain(n);
		}
	});

	it("computer 安全计算表达式与变量", async () => {
		const tools = await loadAll();
		const tool = tools.find((t) => t.name === "computer")!;
		const r1 = (await tool.execute("c1", { expression: "(a + b) * 2 / 3", variables: { a: 10, b: 20 } })) as { content: Array<{ text: string }>; details: { result: number } };
		expect(r1.details.result).toBe(20);
		const r2 = (await tool.execute("c2", { expression: "17 % 5 + 3 * 4" })) as { details: { result: number } };
		expect(r2.details.result).toBe(14);
	});

	it("kanban 增删改查(move/list)", async () => {
		const boardFile = path.join(root, "kanban-test.json");
		process.env.KANBAN_FILE = boardFile;
		try {
			const tools = await loadAll();
			const tool = tools.find((t) => t.name === "kanban")!;
			const added = (await tool.execute("k1", { op: "add", title: "分析会话", description: "s1" })) as { details: { id: string } };
			expect(added.details.id).toMatch(/^K\d+$/);
			await tool.execute("k2", { op: "move", id: added.details.id, status: "inprogress" });
			const listed = (await tool.execute("k3", { op: "list", statusFilter: "inprogress" })) as { details: { items: unknown[] } };
			expect(listed.details.items).toHaveLength(1);
		} finally {
			delete process.env.KANBAN_FILE;
		}
	});

	it("table_generate 生成 Markdown 表格与 mermaid", async () => {
		const tools = await loadAll();
		const tool = tools.find((t) => t.name === "table_generate")!;
		const r = (await tool.execute("t1", { title: "车型", rows: [{ name: "汉EV", price: "25万" }, { name: "Model Y", price: "28万" }], chartType: "both", pie: [{ label: "A", value: 1 }, { label: "B", value: 2 }] })) as { content: Array<{ text: string }> };
		const text = r.content.map((c) => c.text).join("");
		expect(text).toContain("| name | price |");
		expect(text).toContain("```mermaid");
	});

	it("subagents 队列 create/list", async () => {
		const dir = path.join(root, "subagents-test");
		process.env.SUBAGENTS_DIR = dir;
		try {
			const tools = await loadAll();
			const tool = tools.find((t) => t.name === "subagents")!;
			const created = (await tool.execute("s1", { op: "create", title: "子任务A", goal: "分析 c_001" })) as { details: { id: string } };
			expect(created.details.id).toBeTruthy();
			const listed = (await tool.execute("s2", { op: "list" })) as { details: { tasks: unknown[] } };
			expect(listed.details.tasks).toHaveLength(1);
		} finally {
			delete process.env.SUBAGENTS_DIR;
		}
	});

describe("文件读取工具(txt/excel/ppt)", () => {
	const SYS = ["E:\\proj_help_sale\\tools_system"];
	async function loadAll() {
		return loadExternalAgentTools(SYS, { db: null, tenantId: "t1" } as never);
	}

	it("三个文件读取工具可加载", async () => {
		const tools = await loadAll();
		const names = tools.map((t) => t.name);
		for (const n of ["txt", "excel", "ppt"]) expect(names).toContain(n);
	});

	it("txt 读取仓库内文本,路径穿越被拦截", async () => {
		const file = path.join(process.cwd(), ".tmp", `ft-txt-${Date.now()}.txt`);
		fs.writeFileSync(file, "你好,测试内容 abc", "utf8");
		try {
			const tools = await loadAll();
			const tool = tools.find((t) => t.name === "txt")!;
			const ok = (await tool.execute("x", { filePath: file })) as { content: Array<{ text: string }> };
			expect(ok.content.map((c) => c.text).join("")).toContain("测试内容");
			const bad = (await tool.execute("x", { filePath: "../../outside.txt" })) as { content: Array<{ text: string }> };
			expect(bad.content.map((c) => c.text).join("")).toContain("路径无效");
		} finally {
			fs.rmSync(file, { force: true });
		}
	});

	it("excel 读取表格内容", async () => {
		const XLSX = (await import("xlsx")) as typeof import("xlsx");
		const wb = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["车型", "价格"], ["汉EV", "25万"], ["Model Y", "28万"]]), "车型表");
		const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
		const file = path.join(process.cwd(), ".tmp", `ft-xlsx-${Date.now()}.xlsx`);
		fs.writeFileSync(file, buf);
		try {
			const tools = await loadAll();
			const tool = tools.find((t) => t.name === "excel")!;
			const r = (await tool.execute("x", { filePath: file, sheet: "车型表" })) as { content: Array<{ text: string }>; details: { totalRows: number } };
			const text = r.content.map((c) => c.text).join("");
			expect(text).toContain("汉EV");
			expect(r.details.totalRows).toBe(3);
		} finally {
			fs.rmSync(file, { force: true });
		}
	});

	it("ppt 提取幻灯片文字", async () => {
		const AdmZip = (await import("adm-zip")).default;
		const zip = new AdmZip();
		zip.addFile("ppt/presentation.xml", Buffer.from("<p:presentation/>"));
		zip.addFile("ppt/slides/slide1.xml", Buffer.from('<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>汉EV 方案</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>'));
		const file = path.join(process.cwd(), ".tmp", `ft-ppt-${Date.now()}.pptx`);
		zip.writeZip(file);
		try {
			const tools = await loadAll();
			const tool = tools.find((t) => t.name === "ppt")!;
			const r = (await tool.execute("x", { filePath: file })) as { content: Array<{ text: string }> };
			expect(r.content.map((c) => c.text).join("")).toContain("汉EV 方案");
		} finally {
			fs.rmSync(file, { force: true });
		}
	});
});

	it("excel 每页 10 行,支持翻页", async () => {
		const XLSX = (await import("xlsx")) as typeof import("xlsx");
		const rows = [["序号", "客户"]];
		for (let i = 1; i <= 12; i++) rows.push([String(i), "客户" + i]);
		const wb = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "名单");
		const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
		const file = path.join(process.cwd(), ".tmp", `ft-xlsx-page-${Date.now()}.xlsx`);
		fs.writeFileSync(file, buf);
		try {
			const tools = await loadAll();
			const tool = tools.find((t) => t.name === "excel")!;
			const p1 = (await tool.execute("x", { filePath: file })) as { details: { page: number; pageSize: number; totalRows: number; totalPages: number; hasMore: boolean; rows: unknown[] } };
			expect(p1.details.totalRows).toBe(13);
			expect(p1.details.pageSize).toBe(10);
			expect(p1.details.totalPages).toBe(2);
			expect(p1.details.hasMore).toBe(true);
			expect(p1.details.rows).toHaveLength(10);
			const p2 = (await tool.execute("x", { filePath: file, page: 2 })) as { details: { rows: unknown[]; page: number; hasMore: boolean } };
			expect(p2.details.rows).toHaveLength(3);
			expect(p2.details.page).toBe(2);
			expect(p2.details.hasMore).toBe(false);
		} finally {
			fs.rmSync(file, { force: true });
		}
	});
});
