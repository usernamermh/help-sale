import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadExternalAgentTools } from "./external-tools.js";
import { repoRoot } from "../../../../tools_system/_shared/file-utils.js";

const ROOTS = [path.join(repoRoot(), "tools"), path.join(repoRoot(), "tools_system")];
const tmpDirs: string[] = [];

function tmpDir(): string {
	const d = path.join(os.tmpdir(), `fwn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	tmpDirs.push(d);
	return d;
}

afterEach(() => {
	for (const d of tmpDirs.splice(0)) {
		try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
	}
});

async function fileWriteNew(params: Record<string, unknown>) {
	const tools = await loadExternalAgentTools(ROOTS, { db: null, tenantId: "t1" } as never);
	const tool = tools.find((t) => t.name === "file_write_new")!;
	const r = (await tool.execute("w1", params)) as { content: Array<{ text: string }>; details?: Record<string, unknown> };
	return { text: r.content.map((c) => c.text).join(""), details: r.details };
}

describe("file_write_new 任意路径写新文件", () => {
	it("创建新文件成功,内容与编码正确", async () => {
		const dir = tmpDir();
		const f = path.join(dir, "report.txt");
		const { text, details } = await fileWriteNew({ filePath: f, content: "销售军师-新文件\n第二行" });
		expect(text).toContain("已写入");
		expect(fs.existsSync(f)).toBe(true);
		expect(fs.readFileSync(f, "utf8")).toBe("销售军师-新文件\n第二行");
		expect((details as { created: boolean }).created).toBe(true);
	});

	it("已存在的文件拒绝覆盖,原内容保持不变", async () => {
		const dir = tmpDir();
		fs.mkdirSync(dir, { recursive: true });
		const f = path.join(dir, "existing.txt");
		fs.writeFileSync(f, "原始内容", "utf8");
		const { text } = await fileWriteNew({ filePath: f, content: "新内容" });
		expect(text).toContain("已存在");
		expect(fs.readFileSync(f, "utf8")).toBe("原始内容");
	});

	it("父目录不存在时自动创建并写入", async () => {
		const dir = tmpDir();
		const f = path.join(dir, "a", "b", "deep.txt");
		const { text } = await fileWriteNew({ filePath: f, content: "深层目录" });
		expect(text).toContain("已写入");
		expect(fs.readFileSync(f, "utf8")).toBe("深层目录");
	});

	it("内容超限拒绝", async () => {
		const dir = tmpDir();
		const f = path.join(dir, "big.txt");
		const { text } = await fileWriteNew({ filePath: f, content: "x".repeat(2 * 1024 * 1024) });
		expect(text).toContain("超过");
		expect(fs.existsSync(f)).toBe(false);
	});

	it("缺少路径或内容拒绝", async () => {
		const dir = tmpDir();
		const r1 = await fileWriteNew({ filePath: path.join(dir, "a.txt") });
		expect(r1.text).toContain("需要");
		const r2 = await fileWriteNew({ content: "内容" });
		expect(r2.text).toContain("需要");
	});
});