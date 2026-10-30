import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../../backend/db/database.js";
import { requireTenant } from "../../backend/integrations_pi/tables/crm/customers.js";
import { commandHelp, parseCommand, runWeixinCommand } from "./commands.js";
import { getWeixinUser, listWeixinThreads } from "./tables.js";

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "weixin-cmd-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
	tempDir();
	const db = openDatabase(":memory:");
	requireTenant(db, "t_test", "测试租户");
	return { db, openid: "wxid_cmd" };
}

function ctx(db: ReturnType<typeof openDatabase>, openid: string) {
	return { db, tenantId: "t_test", openid, sessionsLimit: 10, status: () => ({ loggedIn: true, polling: true, lastError: null }) };
}

describe("命令解析", () => {
	it("识别英文与中文命令,普通消息原样放行", () => {
		expect(parseCommand("/new")).toEqual({ name: "new", args: "" });
		expect(parseCommand("/switch 2")).toEqual({ name: "switch", args: "2" });
		expect(parseCommand("/帮助")).toEqual({ name: "help", args: "" });
		expect(parseCommand("/绑定 sales:S01")).toEqual({ name: "bind", args: "sales:S01" });
		expect(parseCommand("今天有哪些待跟进")).toBeUndefined();
		expect(parseCommand("看下 /sessions 怎么写")).toBeUndefined();
	});

	it("帮助清单覆盖核心命令", () => {
		const help = commandHelp();
		for (const name of ["/help", "/new", "/sessions", "/switch", "/compact", "/clear", "/stop", "/status", "/whoami", "/title", "/bind"]) {
			expect(help).toContain(name);
		}
	});
});

describe("命令行为", () => {
	it("/new 建新会话并登记会话目录", async () => {
		const { db, openid } = fixture();
		const first = await runWeixinCommand(ctx(db, openid), "/new");
		expect(first).toContain("已新建会话");
		const user = getWeixinUser(db, "t_test", openid);
		expect(user?.threadId).toBeTruthy();
		const rows = db.prepare("SELECT COUNT(*) AS c FROM weixin_threads WHERE tenant_id = ? AND openid = ?").get("t_test", openid) as { c: number };
		expect(Number(rows.c)).toBe(1);

		await runWeixinCommand(ctx(db, openid), "/new");
		const threads = listWeixinThreads(db, "t_test", openid, 10);
		expect(threads).toHaveLength(2);
		expect(getWeixinUser(db, "t_test", openid)?.threadId).toBe(threads[0].threadId);
		db.close();
	});

	it("/sessions 列出会话并标出当前,/switch 切过去", async () => {
		const { db, openid } = fixture();
		await runWeixinCommand(ctx(db, openid), "/new");
		const firstId = getWeixinUser(db, "t_test", openid)!.threadId!;
		await runWeixinCommand(ctx(db, openid), "/new");

		const list = await runWeixinCommand(ctx(db, openid), "/sessions");
		expect(list).toContain("1. ");
		expect(list).toContain("← 当前");
		expect(list).toContain("/switch");

		// 两个会话在同一毫秒建立,列表顺序可能是任一边 —— 按序号定位"不是当前"的那条
		const currentId = getWeixinUser(db, "t_test", openid)!.threadId!;
		const rows = listWeixinThreads(db, "t_test", openid, 10);
		const otherIndex = rows.findIndex((row) => row.threadId !== currentId);
		expect(otherIndex).toBeGreaterThanOrEqual(0);
		const switched = await runWeixinCommand(ctx(db, openid), `/switch ${otherIndex + 1}`);
		expect(switched).toContain("已切到会话");
		const nowCurrent = getWeixinUser(db, "t_test", openid)!.threadId!;
		expect(nowCurrent).toBe(rows[otherIndex].threadId);
		expect(nowCurrent).not.toBe(currentId);
		expect(firstId).toContain("-");
		db.close();
	});

	it("/compact /clear /stop /status /whoami /bind 都有回应", async () => {
		const { db, openid } = fixture();
		await runWeixinCommand(ctx(db, openid), "/new");
		expect(await runWeixinCommand(ctx(db, openid), "/compact")).toContain("已压缩");
		expect(await runWeixinCommand(ctx(db, openid), "/stop")).toContain("已请求中止");
		expect(await runWeixinCommand(ctx(db, openid), "/status")).toContain("租户：t_test");
		expect(await runWeixinCommand(ctx(db, openid), "/whoami")).toContain("尚未绑定");
		expect(await runWeixinCommand(ctx(db, openid), "/bind sales:S01")).toContain("已绑定 sales：S01");
		expect(getWeixinUser(db, "t_test", openid)?.boundId).toBe("S01");
		const cleared = await runWeixinCommand(ctx(db, openid), "/clear");
		expect(cleared).toContain("已清空");
		db.close();
	});

	it("未知命令回清单,非法参数给用法", async () => {
		const { db, openid } = fixture();
		const unknown = await runWeixinCommand(ctx(db, openid), "/whatever");
		expect(unknown).toContain("没有这个命令");
		expect(unknown).toContain("/help");
		expect(await runWeixinCommand(ctx(db, openid), "/bind oops")).toContain("用法");
		expect(await runWeixinCommand(ctx(db, openid), "/switch")).toContain("用法");
		db.close();
	});
});