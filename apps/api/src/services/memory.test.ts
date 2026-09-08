import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendMemory, loadMemoryText, MEMORY_SECTIONS, MEMORY_TEMPLATE } from "./memory.js";

const dirs: string[] = [];
function tmpFile(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-"));
	dirs.push(dir);
	return path.join(dir, "memory.md");
}
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("memory", () => {
	it("文件不存在时返回模板", () => {
		expect(loadMemoryText(tmpFile())).toContain("# 记忆文件");
		expect(MEMORY_TEMPLATE).toContain("## 工具经验");
	});

	it("append 追加到指定小节并落盘,重复行去重", () => {
		const file = tmpFile();
		appendMemory(file, "工具经验", "检索话术时优先用客户原话");
		appendMemory(file, "工具经验", "检索话术时优先用客户原话");
		const text = loadMemoryText(file);
		expect(text.split("- 检索话术时优先用客户原话")).toHaveLength(2); // 标题行不含该文本,追加后一条
		expect(text).toContain("## 工具经验\n- 检索话术时优先用客户原话");
	});

	it("非法小节抛错", () => {
		expect(() => appendMemory(tmpFile(), "客户档案", "x")).toThrow(/小节/);
		expect(MEMORY_SECTIONS).toContain("用户记忆");
		expect(MEMORY_SECTIONS).toContain("系统记忆");
	});
});