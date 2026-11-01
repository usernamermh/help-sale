import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { WeixinAccount } from "./types.js";

/** 微信通道的本地状态:账号凭据、同步游标、每个联系人最新的 context_token。 */

/**
 * 微信状态目录。带 tenantId 时按门店分槽(data/weixin/tenants/<门店>),
 * 每个门店只允许一个登录账号 —— 账号凭据、同步游标、context_token 都是门店私有的。
 */
export function weixinStateDir(dataDir: string, tenantId?: string): string {
	const base = path.join(dataDir, "weixin");
	const dir = tenantId ? path.join(base, "tenants", String(tenantId).replace(/[^A-Za-z0-9_.-]/g, "_")) : base;
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** 磁盘上已有登录状态的门店(启动时据此拉起各自的轮询)。 */
export function listTenantStateIds(dataDir: string): string[] {
	const dir = path.join(dataDir, "weixin", "tenants");
	if (!existsSync(dir)) return [];
	try {
		return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
	} catch {
		return [];
	}
}

function writeAtomic(file: string, content: string): void {
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, content, "utf8");
	renameSync(tmp, file);
}

function readJson<T>(file: string): T | undefined {
	if (!existsSync(file)) return undefined;
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return undefined;
	}
}

export function readAccount(dataDir: string, tenantId?: string): WeixinAccount | undefined {
	const value = readJson<WeixinAccount>(path.join(weixinStateDir(dataDir, tenantId), "account.json"));
	if (!value || typeof value.accountId !== "string" || typeof value.token !== "string") return undefined;
	return value;
}

export function writeAccount(dataDir: string, account: WeixinAccount, tenantId?: string): void {
	writeAtomic(path.join(weixinStateDir(dataDir, tenantId), "account.json"), JSON.stringify(account, null, 2));
}

export function clearAccount(dataDir: string, tenantId?: string): void {
	const file = path.join(weixinStateDir(dataDir, tenantId), "account.json");
	if (existsSync(file)) writeAtomic(file, "{}");
}

function contextFile(dataDir: string, tenantId?: string): string {
	return path.join(weixinStateDir(dataDir, tenantId), "context-tokens.json");
}

/** context_token 按 accountId:userId 存;每次收到消息刷新一次。 */
export function readContextToken(dataDir: string, accountId: string, userId: string, tenantId?: string): string | undefined {
	const all = readJson<Record<string, string>>(contextFile(dataDir, tenantId)) ?? {};
	const value = all[`${accountId}:${userId}`];
	return typeof value === "string" && value ? value : undefined;
}

export function setContextToken(dataDir: string, accountId: string, userId: string, token: string, tenantId?: string): void {
	if (!token) return;
	const all = readJson<Record<string, string>>(contextFile(dataDir, tenantId)) ?? {};
	all[`${accountId}:${userId}`] = token;
	writeAtomic(contextFile(dataDir, tenantId), JSON.stringify(all));
}

export function dropContextToken(dataDir: string, accountId: string, userId: string, tenantId?: string): void {
	const all = readJson<Record<string, string>>(contextFile(dataDir, tenantId)) ?? {};
	delete all[`${accountId}:${userId}`];
	writeAtomic(contextFile(dataDir, tenantId), JSON.stringify(all));
}

function syncFile(dataDir: string, accountId: string, tenantId?: string): string {
	return path.join(weixinStateDir(dataDir, tenantId), `sync-buf-${accountId.replace(/[^\w.-]/g, "_")}.txt`);
}

export function readSyncBuf(dataDir: string, accountId: string, tenantId?: string): string {
	const file = syncFile(dataDir, accountId, tenantId);
	if (!existsSync(file)) return "";
	try {
		return readFileSync(file, "utf8").trim();
	} catch {
		return "";
	}
}

export function writeSyncBuf(dataDir: string, accountId: string, syncBuf: string, tenantId?: string): void {
	if (!syncBuf) return;
	writeAtomic(syncFile(dataDir, accountId, tenantId), syncBuf);
}

/** 短时去重:同一 message_id 与相同文本(同联系人)在窗口内只处理一次。 */
export class WeixinDedup {
	private readonly seen = new Map<string, number>();

	constructor(private readonly ttlMs: number, private readonly now: () => number = Date.now) {}

	isDuplicate(key: string): boolean {
		if (!key) return false;
		const now = this.now();
		for (const [k, at] of this.seen) {
			if (now - at > this.ttlMs) this.seen.delete(k);
		}
		if (this.seen.has(key)) return true;
		this.seen.set(key, now);
		return false;
	}
}