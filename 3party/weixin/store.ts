import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { WeixinAccount } from "./types.js";

/** 微信通道的本地状态:账号凭据、同步游标、每个联系人最新的 context_token。 */

export function weixinStateDir(dataDir: string): string {
	const dir = path.join(dataDir, "weixin");
	mkdirSync(dir, { recursive: true });
	return dir;
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

export function readAccount(dataDir: string): WeixinAccount | undefined {
	const value = readJson<WeixinAccount>(path.join(weixinStateDir(dataDir), "account.json"));
	if (!value || typeof value.accountId !== "string" || typeof value.token !== "string") return undefined;
	return value;
}

export function writeAccount(dataDir: string, account: WeixinAccount): void {
	writeAtomic(path.join(weixinStateDir(dataDir), "account.json"), JSON.stringify(account, null, 2));
}

export function clearAccount(dataDir: string): void {
	const file = path.join(weixinStateDir(dataDir), "account.json");
	if (existsSync(file)) writeAtomic(file, "{}");
}

function contextFile(dataDir: string): string {
	return path.join(weixinStateDir(dataDir), "context-tokens.json");
}

/** context_token 按 accountId:userId 存;每次收到消息刷新一次。 */
export function readContextToken(dataDir: string, accountId: string, userId: string): string | undefined {
	const all = readJson<Record<string, string>>(contextFile(dataDir)) ?? {};
	const value = all[`${accountId}:${userId}`];
	return typeof value === "string" && value ? value : undefined;
}

export function setContextToken(dataDir: string, accountId: string, userId: string, token: string): void {
	if (!token) return;
	const all = readJson<Record<string, string>>(contextFile(dataDir)) ?? {};
	all[`${accountId}:${userId}`] = token;
	writeAtomic(contextFile(dataDir), JSON.stringify(all));
}

export function dropContextToken(dataDir: string, accountId: string, userId: string): void {
	const all = readJson<Record<string, string>>(contextFile(dataDir)) ?? {};
	delete all[`${accountId}:${userId}`];
	writeAtomic(contextFile(dataDir), JSON.stringify(all));
}

function syncFile(dataDir: string, accountId: string): string {
	return path.join(weixinStateDir(dataDir), `sync-buf-${accountId.replace(/[^\w.-]/g, "_")}.txt`);
}

export function readSyncBuf(dataDir: string, accountId: string): string {
	const file = syncFile(dataDir, accountId);
	if (!existsSync(file)) return "";
	try {
		return readFileSync(file, "utf8").trim();
	} catch {
		return "";
	}
}

export function writeSyncBuf(dataDir: string, accountId: string, syncBuf: string): void {
	if (!syncBuf) return;
	writeAtomic(syncFile(dataDir, accountId), syncBuf);
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