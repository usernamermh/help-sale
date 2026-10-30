/**
 * 账户与密钥的独立来源。
 *
 * 配置分三层,职责不同:
 *   1) help-sale.config.yaml      —— 部署/云端管理员负责(端口、存储、模型端点、开关…)
 *   2) help-sale.secrets.yaml     —— 账户名/密码/密钥一类(数据库账号、模型 key、PAT、渠道令牌);
 *                                    可改用环境变量注入,值里写 ${ENV:变量名}
 *   3) 运行时落盘                  —— 扫码登录等产生的东西(如 data/weixin/account.json)
 *
 * 本文件只负责第 2 层:定位文件、解析 ${ENV:...} / ${SECRETS:a.b.c} 占位、把密钥合并进主配置、
 * 并对"密钥还写在主配置里"这种情况给出迁移告警。绝不打印密钥值。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";

export interface SecretsDocument {
	raw: Record<string, unknown>;
	/** 实际读到的文件路径(没有就是 undefined) */
	source?: string;
}

/** 敏感键路径:这些值属于"账户/密钥",不该长期留在主配置里。 */
export const SENSITIVE_KEYS = [
	"model.apiKey",
	"tools.webSearch.apiKey",
	"mysql.user",
	"mysql.password",
	"redis.password",
	"weixin.accountId",
	"weixin.token",
	"mcp.servers[].pat",
	"tenant.apiKeys",
] as const;

/** 密钥文件位置:SECRETS_PATH 优先,否则取主配置同目录下的 help-sale.secrets.yaml。 */
export function locateSecretsFile(mainConfigPath: string | undefined): string | undefined {
	const override = process.env.SECRETS_PATH;
	if (override) {
		if (!existsSync(override)) throw new Error(`SECRETS_PATH 指向的文件不存在:${override}`);
		return override;
	}
	if (!mainConfigPath) return undefined;
	const candidate = path.join(path.dirname(mainConfigPath), "help-sale.secrets.yaml");
	return existsSync(candidate) ? candidate : undefined;
}

/** 读取密钥文件;文件不存在返回空文档(此时所有密钥都必须由主配置或环境变量提供)。 */
export function loadSecretsDocument(mainConfigPath: string | undefined): SecretsDocument {
	const file = locateSecretsFile(mainConfigPath);
	if (!file) return { raw: {} };
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		throw new Error(`无法读取密钥文件 ${file}: ${(error as Error).message}`);
	}
	const parsed = parse(text);
	if (parsed === null || parsed === undefined) return { raw: {}, source: file };
	if (typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`密钥文件 ${file} 顶层必须是键值映射`);
	}
	return { raw: parsed as Record<string, unknown>, source: file };
}

const PLACEHOLDER_RE = /^\$\{(ENV|SECRETS):([^}]+)\}$/;

function readPath(root: unknown, dotted: string): unknown {
	let cursor: unknown = root;
	for (const part of dotted.split(".")) {
		if (cursor === null || typeof cursor !== "object") return undefined;
		cursor = (cursor as Record<string, unknown>)[part];
	}
	return cursor;
}

function writePath(root: Record<string, unknown>, dotted: string, value: unknown): void {
	const parts = dotted.split(".");
	let cursor: Record<string, unknown> = root;
	for (const part of parts.slice(0, -1)) {
		const next = cursor[part];
		if (next === null || typeof next !== "object" || Array.isArray(next)) {
			cursor[part] = {};
		}
		cursor = cursor[part] as Record<string, unknown>;
	}
	cursor[parts[parts.length - 1]] = value;
}

/**
 * 解析整棵配置里的 ${ENV:X} / ${SECRETS:a.b.c} 占位。
 * 占位取不到值直接报错(并指出是哪个键),不做静默兜底。
 */
export function resolvePlaceholders(
	value: unknown,
	secrets: SecretsDocument,
	keyPath = "",
): unknown {
	if (typeof value === "string") {
		const match = PLACEHOLDER_RE.exec(value.trim());
		if (!match) return value;
		const [, kind, name] = match;
		if (kind === "ENV") {
			const env = process.env[name];
			if (env === undefined || env === "") {
				throw new Error(`配置项 ${keyPath} 写的是 \${ENV:${name}},但没有读到环境变量 ${name}(请在部署环境里注入该变量)`);
			}
			return env;
		}
		const fromSecrets = readPath(secrets.raw, name);
		if (fromSecrets === undefined) {
			throw new Error(`配置项 ${keyPath} 写的是 \${SECRETS:${name}},但密钥文件里没有 ${name}(见 help-sale.secrets.yaml)`);
		}
		return fromSecrets;
	}
	if (Array.isArray(value)) {
		return value.map((item, index) => resolvePlaceholders(item, secrets, `${keyPath}[${index}]`));
	}
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			out[key] = resolvePlaceholders(item, secrets, keyPath ? `${keyPath}.${key}` : key);
		}
		return out;
	}
	return value;
}

/**
 * 把密钥文件里的值合并进主配置:主配置没给(或给空)时以密钥文件为准。
 * 同时统计"哪些敏感键还写在主配置里",交给调用方打迁移告警。
 */
export function mergeSecrets(
	raw: Record<string, unknown>,
	secrets: SecretsDocument,
): { plaintextKeys: string[] } {
	const plaintextKeys: string[] = [];

	const take = (dotted: string): void => {
		const fromSecrets = readPath(secrets.raw, dotted);
		if (fromSecrets === undefined || fromSecrets === "") return;
		const current = readPath(raw, dotted);
		if (current === undefined || current === null || current === "") {
			writePath(raw, dotted, fromSecrets);
			return;
		}
		// 已经是 ${ENV:X} / ${SECRETS:X} 占位:值来自密钥文件或环境变量,不算明文
		if (typeof current === "string" && PLACEHOLDER_RE.test(current.trim())) return;
		plaintextKeys.push(dotted);
	};

	for (const key of SENSITIVE_KEYS) {
		if (key === "mcp.servers[].pat" || key === "tenant.apiKeys") continue;
		take(key);
	}

	// 集成用的租户 API Key 映射(键=Key,值=租户 ID):由密钥文件提供,主配置留空
	const apiKeys = readPath(secrets.raw, "tenant.apiKeys");
	if (apiKeys && typeof apiKeys === "object" && Object.keys(apiKeys as Record<string, unknown>).length > 0) {
		const current = readPath(raw, "tenant.apiKeys");
		if (current === undefined || current === null || (typeof current === "object" && !Array.isArray(current) && Object.keys(current as Record<string, unknown>).length === 0)) {
			writePath(raw, "tenant.apiKeys", apiKeys);
		} else {
			plaintextKeys.push("tenant.apiKeys");
		}
	}

	// MCP 的 PAT 按 server 名映射:secrets 里写 mcp.servers.<name>
	const patMap = readPath(secrets.raw, "mcp.servers");
	const servers = readPath(raw, "mcp.servers");
	if (patMap && typeof patMap === "object" && Array.isArray(servers)) {
		for (const server of servers as Array<Record<string, unknown>>) {
			const name = String(server?.name ?? "");
			const pat = name ? (patMap as Record<string, unknown>)[name] : undefined;
			if (typeof pat !== "string" || pat === "") continue;
			if (server.pat === undefined || server.pat === null || server.pat === "") server.pat = pat;
			else plaintextKeys.push(`mcp.servers[${name}].pat`);
		}
	}
	return { plaintextKeys };
}