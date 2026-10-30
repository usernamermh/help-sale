import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../env.js";
import { auditTableMapping, assertTableMappingComplete, schemaTableNames } from "./schema-audit.js";

function tempSchema(sql: string): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "hs-schema-"));
	const file = path.join(dir, "schema.sql");
	writeFileSync(file, sql, "utf8");
	return file;
}

describe("表映射自检", () => {
	it("当前配置与 schema 一致:没有缺键", () => {
		const audit = assertTableMappingComplete(config.tables);
		expect(audit.missingKeys).toEqual([]);
		expect(audit.schemaTables.length).toBeGreaterThanOrEqual(35);
	});

	it("schema 里有表但映射缺键 → 启动即报错并点名", () => {
		const schema = tempSchema("CREATE TABLE IF NOT EXISTS customers (id TEXT);\nCREATE TABLE IF NOT EXISTS knowledge_embeddings (id TEXT);\n");
		const mapping = { customers: "customers" };
		const audit = auditTableMapping(mapping, { sqlite: schema, mysql: schema });
		expect(audit.missingKeys).toEqual(["knowledge_embeddings"]);
		expect(() => assertTableMappingComplete(mapping, { sqlite: schema, mysql: schema })).toThrow(/knowledge_embeddings/);
	});

	it("映射的值允许改成实际物理表名(只校验键)", () => {
		const schema = tempSchema("CREATE TABLE IF NOT EXISTS customers (id TEXT);\n");
		const audit = assertTableMappingComplete({ customers: "crm_customers" }, { sqlite: schema, mysql: schema });
		expect(audit.missingKeys).toEqual([]);
	});

	it("自定义表(映射有、schema 没有)放行但会被报出来", () => {
		const schema = tempSchema("CREATE TABLE IF NOT EXISTS customers (id TEXT);\n");
		const audit = assertTableMappingComplete({ customers: "customers", my_table: "my_table" }, { sqlite: schema, mysql: schema });
		expect(audit.extraKeys).toEqual(["my_table"]);
	});

	it("两份 schema 取并集:MySQL 独有/带反引号的写法也能识别", () => {
		const sqlite = tempSchema("CREATE TABLE IF NOT EXISTS a (id TEXT);\n");
		const mysql = tempSchema("CREATE TABLE IF NOT EXISTS `b` (id VARCHAR(64));\n");
		const audit = auditTableMapping({ a: "a", b: "b" }, { sqlite, mysql });
		expect(audit.schemaTables).toEqual(["a", "b"]);
		expect(schemaTableNames(sqlite)).toEqual(["a"]);
	});
});