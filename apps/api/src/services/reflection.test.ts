import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../db/database.js";
import { requireTenant } from "../repositories/customers.js";
import { createReflectionCase } from "../repositories/reflection-cases.js";
import { applyReflectionToMemory, collectReflectionSuggestions } from "./reflection.js";

let db: DatabaseSync;
let memFile: string;
beforeEach(() => {
	db = openDatabase(":memory:");
	requireTenant(db, "t1", "演示租户");
	memFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mem-")), "memory.md");
	fs.writeFileSync(memFile, "# 记忆文件(Memory)\n\n## 规则改进\n\n", "utf8");
});
afterEach(() => db.close());

describe("反思与自我改进闭环", () => {
	it("评估低分案例聚合出改进建议", () => {
		createReflectionCase(db, { tenantId: "t1", caseType: "evaluation_low", refId: "r1", detail: { score: 55, improvements: ["报价含糊,未给区间", "缺少逼单动作"] } });
		createReflectionCase(db, { tenantId: "t1", caseType: "evaluation_low", refId: "r2", detail: { score: 60, improvements: ["报价含糊,未给区间"] } });
		const summary = collectReflectionSuggestions(db, "t1", 7);
		expect(summary.caseCounts.find((c) => c.caseType === "evaluation_low")?.count).toBe(2);
		expect(summary.suggestions.some((s) => s.topic.includes("报价含糊"))).toBe(true);
		expect(summary.suggestions.find((s) => s.topic.includes("报价含糊"))!.count).toBe(2);
	});

	it("运行失败案例计入反思摘要", () => {
		createReflectionCase(db, { tenantId: "t1", caseType: "run_failed", detail: { error: "model timeout", goal: "查客户" } });
		const summary = collectReflectionSuggestions(db, "t1", 7);
		expect(summary.caseCounts.find((c) => c.caseType === "run_failed")?.count).toBe(1);
		expect(summary.suggestions.some((s) => s.topic.includes("运行失败"))).toBe(true);
	});

	it("把建议写入 memory「规则改进」小节(去重)", () => {
		createReflectionCase(db, { tenantId: "t1", caseType: "evaluation_low", detail: { score: 50, improvements: ["共情不足"] } });
		const first = applyReflectionToMemory(db, "t1", 7, memFile);
		expect(first.suggestions.length).toBeGreaterThan(0);
		const content1 = fs.readFileSync(memFile, "utf8");
		expect(content1).toContain("反思建议:");
		// 再次应用:内容去重,不重复追加
		applyReflectionToMemory(db, "t1", 7, memFile);
		const content2 = fs.readFileSync(memFile, "utf8");
		expect(content2).toBe(content1);
	});
});