import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { listTenantStateIds, readAccount, readContextToken, readSyncBuf, setContextToken, weixinStateDir, writeAccount, writeSyncBuf } from "./store.js";

/** 微信状态按门店分槽:一个门店一套凭据/游标/context_token,互不可见。 */

let dir: string;
const account = (id: string) => ({ accountId: id, token: `token-${id}`, baseUrl: "https://example.invalid", userId: "", savedAt: "" });

beforeEach(() => {
	dir = mkdtempSync(path.join(os.tmpdir(), "weixin-slot-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("微信状态分槽", () => {
	it("状态目录按门店分开;老的单账号槽位仍在原位", () => {
		const legacy = weixinStateDir(dir);
		const t1 = weixinStateDir(dir, "t1");
		expect(legacy).toBe(path.join(dir, "weixin"));
		expect(t1).toBe(path.join(dir, "weixin", "tenants", "t1"));
		expect(t1).not.toBe(legacy);
	});

	it("账号凭据互不可见,且能按磁盘列出门店", () => {
		writeAccount(dir, account("wx-t1"), "t1");
		writeAccount(dir, account("wx-t2"), "t2");
		expect(readAccount(dir, "t1")?.accountId).toBe("wx-t1");
		expect(readAccount(dir, "t2")?.accountId).toBe("wx-t2");
		// 老槽位没有被写脏
		expect(readAccount(dir)).toBeUndefined();
		expect(listTenantStateIds(dir).sort()).toEqual(["t1", "t2"]);
	});

	it("同步游标与 context_token 也按门店隔离", () => {
		writeSyncBuf(dir, "wx-t1", "cursor-of-t1", "t1");
		expect(readSyncBuf(dir, "wx-t1", "t1")).toBe("cursor-of-t1");
		expect(readSyncBuf(dir, "wx-t1", "t2")).toBe("");

		setContextToken(dir, "wx-t1", "user-1", "ctx-t1", "t1");
		expect(readContextToken(dir, "wx-t1", "user-1", "t1")).toBe("ctx-t1");
		expect(readContextToken(dir, "wx-t1", "user-1", "t2")).toBeUndefined();
	});

	it("门店标识里的路径字符被清洗,不会越出状态根目录", () => {
		const escaped = weixinStateDir(dir, "../../etc");
		expect(escaped.startsWith(path.join(dir, "weixin", "tenants") + path.sep)).toBe(true);
	});
});