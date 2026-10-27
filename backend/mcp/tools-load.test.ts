import { describe, expect, it } from "vitest";
import { scanExternalTools, TOOL_ROOTS, checkToolRequires } from "../services/external-tools.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const all = scanExternalTools(TOOL_ROOTS.map((r) => path.join(repoRoot, r)));

describe("工具目录扫描与新工具", () => {
	it("扫描到 web_search / terminal 新工具,且 web 已合并删除", () => {
		const names = all.map((t) => t.name);
		expect(names).toContain("web_search");
		expect(names).toContain("terminal");
		expect(names).not.toContain("web");
	});

	it("checkToolRequires:有密钥时 web_search 可用,无密钥不可用", () => {
		const w = all.find((t) => t.name === "web_search");
		expect(w?.requires?.length).toBeGreaterThan(0);
		expect(checkToolRequires(w!.requires, { webSearchApiKey: "key" })).toBe(true);
		expect(checkToolRequires(w!.requires, { webSearchApiKey: "" })).toBe(false);
	});

	it("checkToolRequires:terminal 无门槛,始终可用", () => {
		const t = all.find((x) => x.name === "terminal");
		expect(checkToolRequires(t!.requires, { webSearchApiKey: "" })).toBe(true);
	});
});