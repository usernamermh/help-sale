import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSecretsDocument, mergeSecrets, resolvePlaceholders, SENSITIVE_KEYS } from "./secrets.js";

const dirs: string[] = [];
afterEach(() => {
	delete process.env.SECRETS_PATH;
	delete process.env.HS_TEST_KEY;
	vi.resetModules();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempSecrets(content: string): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "hs-secrets-"));
	dirs.push(dir);
	const file = path.join(dir, "help-sale.secrets.yaml");
	writeFileSync(file, content, "utf8");
	return file;
}

describe("占位解析", () => {
	it("${ENV:VAR} 从环境变量取值", () => {
		process.env.HS_TEST_KEY = "from-env";
		const resolved = resolvePlaceholders({ a: { apiKey: "${ENV:HS_TEST_KEY}" } }, { raw: {} }) as Record<string, any>;
		expect(resolved.a.apiKey).toBe("from-env");
	});

	it("环境变量缺失时报错并指出键名", () => {
		expect(() => resolvePlaceholders({ a: { apiKey: "${ENV:NOT_SET_KEY}" } }, { raw: {} }, "a.apiKey")).toThrow(/NOT_SET_KEY/);
	});

	it("${SECRETS:a.b} 从密钥文档取值,缺项报错", () => {
		const secrets = { raw: { mysql: { password: "p@ss" } } };
		expect((resolvePlaceholders({ v: "${SECRETS:mysql.password}" }, secrets) as Record<string, string>).v).toBe("p@ss");
		expect(() => resolvePlaceholders({ v: "${SECRETS:mysql.user}" }, secrets, "v")).toThrow(/help-sale.secrets.yaml/);
	});
});

describe("密钥文件合并", () => {
	it("主配置留空时由密钥文件补齐,并识别还写在主配置里的敏感项", () => {
		const secrets = { raw: { mysql: { user: "help_sale_rw", password: "s3cret" }, model: { apiKey: "sk-x" } } };
		const raw: Record<string, unknown> = { mysql: { host: "127.0.0.1", user: "", password: "" }, model: { apiKey: "plaintext-in-main" } };
		const { plaintextKeys } = mergeSecrets(raw, secrets);
		expect((raw.mysql as Record<string, unknown>).user).toBe("help_sale_rw");
		expect((raw.mysql as Record<string, unknown>).password).toBe("s3cret");
		expect((raw.model as Record<string, unknown>).apiKey).toBe("plaintext-in-main");
		expect(plaintextKeys).toContain("model.apiKey");
	});

	it("写成占位不算明文,不产生迁移告警", () => {
		const secrets = { raw: { model: { apiKey: "sk-x" }, mysql: { password: "s3cret" } } };
		const raw: Record<string, unknown> = { model: { apiKey: "${SECRETS:model.apiKey}" }, mysql: { password: "${ENV:MYSQL_PASSWORD}" } };
		const { plaintextKeys } = mergeSecrets(raw, secrets);
		expect(plaintextKeys).toEqual([]);
	});

	it("MCP 的 PAT 按 server 名从密钥文件映射", () => {
		const secrets = { raw: { mcp: { servers: { github: "ghp_x" } } } };
		const raw: Record<string, unknown> = { mcp: { servers: [{ name: "github", url: "https://example/mcp" }] } };
		mergeSecrets(raw, secrets);
		const servers = (raw.mcp as { servers: Array<Record<string, unknown>> }).servers;
		expect(servers[0].pat).toBe("ghp_x");
	});

	it("读取密钥文件:文件不存在时返回空文档,文件存在时按路径取值", () => {
		expect(loadSecretsDocument("E:/definitely/not/here/help-sale.config.yaml").raw).toEqual({});
		const file = tempSecrets("redis:\n  password: r3d\n");
		process.env.SECRETS_PATH = file;
		const doc = loadSecretsDocument(undefined);
		expect(doc.source).toBe(file);
		expect((resolvePlaceholders({ v: "${SECRETS:redis.password}" }, doc) as Record<string, string>).v).toBe("r3d");
	});

	it("敏感键清单覆盖账户/密钥类配置", () => {
		for (const key of ["model.apiKey", "mysql.password", "redis.password", "tools.webSearch.apiKey", "mcp.servers[].pat"]) {
			expect(SENSITIVE_KEYS).toContain(key);
		}
	});
});