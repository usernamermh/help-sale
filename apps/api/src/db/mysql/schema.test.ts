import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "schema.sql");
const schema = fs.readFileSync(schemaPath, "utf8");

describe("mysql schema.sql 语法体检", () => {
	it("不包含重复 DEFAULT / NOT NULL / PRIMARY KEY 子句", () => {
		expect(schema).not.toMatch(/DEFAULT\s+['"][^'"]*['"]\s+DEFAULT/);
		expect(schema).not.toMatch(/NOT NULL\s+NOT NULL/);
		expect(schema).not.toMatch(/PRIMARY KEY\s+PRIMARY KEY/);
		expect(schema).not.toMatch(/,\s*,/);
	});

	it("每条语句都以分号结束、括号闭合", () => {
		const statements = schema
			.split(";")
			.map((s) => s.trim())
			.filter(Boolean);
		expect(statements.length).toBeGreaterThanOrEqual(23);
		for (const stmt of statements) {
			const opens = (stmt.match(/\(/g) || []).length;
			const closes = (stmt.match(/\)/g) || []).length;
			expect(opens).toBe(closes);
			expect(stmt).toMatch(/CREATE TABLE IF NOT EXISTS/i);
		}
	});
});
