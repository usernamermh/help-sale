import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../../backend/db/database.js";
import { requireTenant } from "../../backend/integrations_pi/tables/crm/customers.js";
import { createWeixinDispatcher } from "./dispatch.js";
import { describeError, ilinkHeaders, isRateLimited, isSessionExpired, isSuccess, toInbound } from "./ilink.js";
import { sendWeixinText } from "./send.js";
import { WeixinDedup, readAccount, readContextToken, readSyncBuf, setContextToken, writeAccount, writeSyncBuf } from "./store.js";
import { subscribeThreadEvents, type ThreadEvent } from "../../backend/services/thread-events.js";
import { extractText, maskId, splitText, toPlainText } from "./text.js";

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "weixin-test-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function jsonResponse(payload: unknown): Response {
	return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("iLink 协议层", () => {
	it("请求头带应用标识,token 为空时不带 Authorization", () => {
		const withToken = ilinkHeaders("tk");
		expect(withToken.AuthorizationType).toBe("ilink_bot_token");
		expect(withToken["iLink-App-Id"]).toBe("bot");
		expect(withToken.Authorization).toBe("Bearer tk");
		expect(Buffer.from(withToken["X-WECHAT-UIN"], "base64").toString("utf8")).toMatch(/^\d+$/);

		const withoutToken = ilinkHeaders(undefined);
		expect(withoutToken.Authorization).toBeUndefined();
	});

	it("把原始消息归一化:文本、群聊 id、context_token 都能取到", () => {
		const inbound = toInbound({
			message_id: " m1 ",
			from_user_id: "wxid_a",
			to_user_id: "bot",
			room_id: "room_1",
			msg_type: 1,
			context_token: "ctx",
			item_list: [{ type: 1, text_item: { text: "你好" } }],
		});
		expect(inbound.messageId).toBe("m1");
		expect(inbound.fromUserId).toBe("wxid_a");
		expect(inbound.roomId).toBe("room_1");
		expect(inbound.contextToken).toBe("ctx");
		expect(extractText(inbound.items)).toBe("你好");
	});

	it("错误分类:会话过期、限流、成功各自区分", () => {
		expect(isSessionExpired({ ret: -14 })).toBe(true);
		expect(isSessionExpired({ ret: -2, errmsg: "unknown error" })).toBe(true);
		expect(isRateLimited({ ret: -2, errmsg: "freq limit" })).toBe(true);
		expect(isRateLimited({ ret: -14 })).toBe(false);
		expect(isSuccess({ ret: 0, errcode: 0 })).toBe(true);
		expect(isSuccess({ errcode: -1 })).toBe(false);
		expect(describeError({ ret: -14, errmsg: "session expired" })).toContain("session expired");
	});
});

describe("文本渲染与分片", () => {
	it("Markdown 转纯文本:去标记、表格转行、链接保留地址", () => {
		const text = toPlainText(["# 标题", "", "**加粗** 和 `代码`", "", "| 客户 | 金额 |", "| --- | --- |", "| 张三 | 100 |", "", "[官网](https://example.com)"].join("\n"));
		expect(text).toContain("标题");
		expect(text).toContain("加粗 和 代码");
		expect(text).toContain("张三 · 100");
		expect(text).toContain("官网 (https://example.com)");
		expect(text).not.toContain("---");
	});

	it("分片不超过上限,内容不丢", () => {
		const content = Array.from({ length: 40 }, (_, i) => `第${i + 1}条跟进记录,客户表示下周再谈。`).join("\n\n");
		const chunks = splitText(content, 80);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(80);
		const squash = (value: string) => value.replace(/\s+/g, "");
		expect(squash(chunks.join(""))).toBe(squash(content));
	});

	it("单个超长句子按字符硬切", () => {
		const chunks = splitText("а".repeat(1).replace("а", "长") + "很长的内容".repeat(30), 20);
		for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(20);
	});

	it("maskId 不暴露完整 id", () => {
		expect(maskId("wxid_abcdefghijklmn")).toContain("***");
		expect(maskId("wxid_abcdefghijklmn")).not.toBe("wxid_abcdefghijklmn");
	});
});

describe("本地状态", () => {
	it("账号、同步游标、context_token 落盘后可读回", () => {
		const dir = tempDir();
		writeAccount(dir, { accountId: "acc", token: "tk", baseUrl: "https://i.example", userId: "u", savedAt: "now" });
		expect(readAccount(dir)?.accountId).toBe("acc");

		writeSyncBuf(dir, "acc", "buf-1");
		expect(readSyncBuf(dir, "acc")).toBe("buf-1");

		setContextToken(dir, "acc", "wxid_a", "ctx-1");
		expect(readContextToken(dir, "acc", "wxid_a")).toBe("ctx-1");
		expect(readContextToken(dir, "acc", "wxid_b")).toBeUndefined();
	});

	it("去重窗口内同一 key 只算一次", () => {
		let now = 1000;
		const dedup = new WeixinDedup(100, () => now);
		expect(dedup.isDuplicate("m1")).toBe(false);
		expect(dedup.isDuplicate("m1")).toBe(true);
		now += 200;
		expect(dedup.isDuplicate("m1")).toBe(false);
	});
});

describe("出站发送", () => {
	const baseOptions = (dir: string, fetchImpl: typeof fetch) => ({
		dataDir: dir,
		baseUrl: "https://ilink.example",
		accountId: "acc",
		token: "tk",
		maxLength: 2000,
		retries: 1,
		retryDelayMs: 0,
		fetchImpl,
		sleepImpl: async () => undefined,
	});

	it("按纯文本发送,成功后回 ok", async () => {
		const dir = tempDir();
		const bodies: Array<Record<string, any>> = [];
		const fetchImpl = (async (_url: string, init?: RequestInit) => {
			bodies.push(JSON.parse(String(init?.body)));
			return jsonResponse({ ret: 0, errcode: 0 });
		}) as unknown as typeof fetch;

		const result = await sendWeixinText(baseOptions(dir, fetchImpl), "wxid_a", "**好的**,明天联系");
		expect(result.ok).toBe(true);
		expect(result.chunks).toBe(1);
		const sent = bodies[0].msg;
		expect(sent.to_user_id).toBe("wxid_a");
		expect(sent.item_list[0].text_item.text).toBe("好的,明天联系");
		expect(bodies[0].base_info.channel_version).toBeTruthy();
	});

	it("context_token 失效时去掉 token 再试一次", async () => {
		const dir = tempDir();
		setContextToken(dir, "acc", "wxid_a", "stale");
		const bodies: Array<Record<string, any>> = [];
		const fetchImpl = (async (_url: string, init?: RequestInit) => {
			bodies.push(JSON.parse(String(init?.body)));
			return bodies.length === 1 ? jsonResponse({ ret: -14, errmsg: "session expired" }) : jsonResponse({ ret: 0, errcode: 0 });
		}) as unknown as typeof fetch;

		const result = await sendWeixinText(baseOptions(dir, fetchImpl), "wxid_a", "继续");
		expect(result.ok).toBe(true);
		expect(bodies[0].msg.context_token).toBe("stale");
		expect(bodies[1].msg.context_token).toBeUndefined();
		expect(readContextToken(dir, "acc", "wxid_a")).toBeUndefined();
	});

	it("一直失败时返回错误而不是抛异常", async () => {
		const dir = tempDir();
		const fetchImpl = (async () => jsonResponse({ ret: -1, errcode: -1, errmsg: "boom" })) as unknown as typeof fetch;
		const result = await sendWeixinText(baseOptions(dir, fetchImpl), "wxid_a", "内容");
		expect(result.ok).toBe(false);
		expect(result.chunks).toBe(0);
		expect(result.error).toContain("boom");
	});
});

describe("入站分发", () => {
	it("一条文字消息:建档、开线程、跑 agent、回消息、留审计", async () => {
		const dir = tempDir();
		const db = openDatabase(":memory:");
		requireTenant(db, "t_test", "测试租户");
		const sent: Array<{ to: string; text: string }> = [];
		let titleDuringRun = "";
		let messagesDuringRun: Array<Record<string, unknown>> = [];
		const fetchImpl = (async (_url: string, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body));
			sent.push({ to: body.msg.to_user_id, text: body.msg.item_list[0].text_item.text });
			return jsonResponse({ ret: 0, errcode: 0 });
		}) as unknown as typeof fetch;

		const dispatcher = createWeixinDispatcher({
			db,
			tenantId: "t_test",
			autoReply: true,
			agentTimeoutMs: 5000,
			allowFrom: [],
			unsupportedText: "不支持",
			ackText: "",
			send: { dataDir: dir, baseUrl: "https://ilink.example", accountId: "acc", token: "tk", maxLength: 2000, retries: 0, retryDelayMs: 0, fetchImpl },
			runAgent: async (input) => {
				// agent 还在跑的时候,网页历史里这条会话就必须已经能打开(有标题、有这轮用户消息)
				const row = db.prepare("SELECT title FROM agent_threads WHERE id = ?").get(input.threadId) as Record<string, unknown>;
				titleDuringRun = String(row.title ?? "");
				messagesDuringRun = db
					.prepare("SELECT role, content_json FROM agent_thread_messages WHERE thread_id = ? ORDER BY seq")
					.all(input.threadId) as Array<Record<string, unknown>>;
				return { runId: "run-1", answer: `收到:${input.goal}` };
			},
		});

		await dispatcher({
			messageId: "m1",
			fromUserId: "wxid_a",
			toUserId: "bot",
			roomId: "",
			msgType: 1,
			items: [{ type: 1, text_item: { text: "今天有哪些待跟进" } }],
			contextToken: "ctx",
			raw: {},
		});

		expect(sent).toHaveLength(1);
		expect(sent[0].text).toBe("收到:今天有哪些待跟进");
		expect(titleDuringRun).toBe("今天有哪些待跟进");
		expect(messagesDuringRun.map((m) => m.role)).toEqual(["user"]);

		const user = db.prepare("SELECT * FROM weixin_users WHERE tenant_id = ? AND openid = ?").get("t_test", "wxid_a") as Record<string, unknown>;
		expect(String(user.thread_id ?? "")).not.toBe("");
		const thread = db.prepare("SELECT * FROM agent_threads WHERE id = ?").get(String(user.thread_id)) as Record<string, unknown>;
		expect(thread.title).toBeTruthy();

		const messages = db.prepare("SELECT direction, status FROM weixin_messages WHERE tenant_id = ? ORDER BY created_at").all("t_test") as Array<Record<string, unknown>>;
		expect(messages.map((m) => `${m.direction}:${m.status}`).sort()).toEqual(["in:received", "out:sent"]);

		// 同一条 message_id 重放不再处理
		await dispatcher({
			messageId: "m1",
			fromUserId: "wxid_a",
			toUserId: "bot",
			roomId: "",
			msgType: 1,
			items: [{ type: 1, text_item: { text: "今天有哪些待跟进" } }],
			contextToken: "ctx",
			raw: {},
		});
		expect(sent).toHaveLength(1);
		db.close();
	});

	it("非文字消息回兜底话术", async () => {
		const dir = tempDir();
		const db = openDatabase(":memory:");
		requireTenant(db, "t_test", "测试租户");
		const sent: string[] = [];
		const fetchImpl = (async (_url: string, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body));
			sent.push(body.msg.item_list[0].text_item.text);
			return jsonResponse({ ret: 0, errcode: 0 });
		}) as unknown as typeof fetch;

		const dispatcher = createWeixinDispatcher({
			db,
			tenantId: "t_test",
			autoReply: true,
			agentTimeoutMs: 5000,
			allowFrom: [],
			unsupportedText: "目前只支持文字消息",
			ackText: "",
			send: { dataDir: dir, baseUrl: "https://ilink.example", accountId: "acc", token: "tk", maxLength: 2000, retries: 0, retryDelayMs: 0, fetchImpl },
			runAgent: async () => ({ answer: "不该被调用" }),
		});

		await dispatcher({
			messageId: "m2",
			fromUserId: "wxid_b",
			toUserId: "bot",
			roomId: "",
			msgType: 1,
			items: [{ type: 2 }],
			contextToken: "",
			raw: {},
		});
		expect(sent).toEqual(["目前只支持文字消息"]);
		db.close();
	});

	it("配置了确认语时:先回确认,再回结果", async () => {
		const dir = tempDir();
		const db = openDatabase(":memory:");
		requireTenant(db, "t_test", "测试租户");
		const sent: string[] = [];
		const fetchImpl = (async (_url: string, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body));
			sent.push(body.msg.item_list[0].text_item.text);
			return jsonResponse({ ret: 0, errcode: 0 });
		}) as unknown as typeof fetch;

		const dispatcher = createWeixinDispatcher({
			db,
			tenantId: "t_test",
			autoReply: true,
			agentTimeoutMs: 5000,
			allowFrom: [],
			unsupportedText: "不支持",
			ackText: "收到,正在处理",
			send: { dataDir: dir, baseUrl: "https://ilink.example", accountId: "acc", token: "tk", maxLength: 2000, retries: 0, retryDelayMs: 0, fetchImpl },
			runAgent: async () => ({ runId: "run-2", answer: "结果在这里" }),
		});

		await dispatcher({
			messageId: "m3",
			fromUserId: "wxid_c",
			toUserId: "bot",
			roomId: "",
			msgType: 1,
			items: [{ type: 1, text_item: { text: "帮我看看客户" } }],
			contextToken: "",
			raw: {},
		});
		expect(sent).toEqual(["收到,正在处理", "结果在这里"]);
		const statuses = db.prepare("SELECT direction, status FROM weixin_messages WHERE tenant_id = ? ORDER BY created_at").all("t_test") as Array<Record<string, unknown>>;
		expect(statuses.map((r) => `${r.direction}:${r.status}`).sort()).toEqual(["in:received", "out:sent", "out:sent"]);
		db.close();
	});

	it("同一联系人连发两条:第二条的确认不会等第一条跑完", async () => {
		const dir = tempDir();
		const db = openDatabase(":memory:");
		requireTenant(db, "t_test", "测试租户");
		const sent: string[] = [];
		const fetchImpl = (async (_url: string, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body));
			sent.push(body.msg.item_list[0].text_item.text);
			return jsonResponse({ ret: 0, errcode: 0 });
		}) as unknown as typeof fetch;

		let releaseRun: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => { releaseRun = resolve; });
		const dispatcher = createWeixinDispatcher({
			db,
			tenantId: "t_test",
			autoReply: true,
			agentTimeoutMs: 5000,
			allowFrom: [],
			unsupportedText: "不支持",
			ackText: "收到",
			send: { dataDir: dir, baseUrl: "https://ilink.example", accountId: "acc", token: "tk", maxLength: 2000, retries: 0, retryDelayMs: 0, fetchImpl },
			runAgent: async () => { await gate; return { runId: "run-3", answer: "结果" }; },
		});
		const inbound = (messageId: string, text: string) => ({
			messageId,
			fromUserId: "wxid_d",
			toUserId: "bot",
			roomId: "",
			msgType: 1,
			items: [{ type: 1, text_item: { text } }],
			contextToken: "",
			raw: {},
		});

		const first = dispatcher(inbound("m4", "第一条"));
		await new Promise((resolve) => setTimeout(resolve, 30));
		const second = dispatcher(inbound("m5", "第二条"));
		await new Promise((resolve) => setTimeout(resolve, 30));
		// 第一条 agent 还卡着,两条确认都已经发出去了
		expect(sent).toEqual(["收到", "收到"]);
		releaseRun();
		await first; await second;
		expect(sent).toEqual(["收到", "收到", "结果", "结果"]);
		db.close();
	});

	it("写入线程时把消息与标题广播给网页端", async () => {
		const dir = tempDir();
		const db = openDatabase(":memory:");
		requireTenant(db, "t_test", "测试租户");
		const events: ThreadEvent[] = [];
		const unsubscribe = subscribeThreadEvents((event) => events.push(event));
		const fetchImpl = (async () => jsonResponse({ ret: 0, errcode: 0 })) as unknown as typeof fetch;
		const dispatcher = createWeixinDispatcher({
			db,
			tenantId: "t_test",
			autoReply: true,
			agentTimeoutMs: 5000,
			allowFrom: [],
			unsupportedText: "不支持",
			ackText: "",
			send: { dataDir: dir, baseUrl: "https://ilink.example", accountId: "acc", token: "tk", maxLength: 2000, retries: 0, retryDelayMs: 0, fetchImpl },
			runAgent: async () => ({ runId: "run-4", answer: "结果" }),
		});
		await dispatcher({
			messageId: "m6",
			fromUserId: "wxid_e",
			toUserId: "bot",
			roomId: "",
			msgType: 1,
			items: [{ type: 1, text_item: { text: "同步到网页" } }],
			contextToken: "",
			raw: {},
		});
		unsubscribe();
		expect(events.map((e) => e.type)).toEqual(["title", "message"]);
		expect(events[0].title).toBe("同步到网页");
		expect(events[1].role).toBe("user");
		expect(events[1].text).toBe("同步到网页");
		expect(events[1].tenantId).toBe("t_test");
		db.close();
	});

	it("命令消息直接回结果:不跑 agent、不发确认语", async () => {
		const dir = tempDir();
		const db = openDatabase(":memory:");
		requireTenant(db, "t_test", "测试租户");
		const sent: string[] = [];
		const fetchImpl = (async (_url: string, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body));
			sent.push(body.msg.item_list[0].text_item.text);
			return jsonResponse({ ret: 0, errcode: 0 });
		}) as unknown as typeof fetch;
		let ranAgent = 0;
		const dispatcher = createWeixinDispatcher({
			db,
			tenantId: "t_test",
			autoReply: true,
			agentTimeoutMs: 5000,
			allowFrom: [],
			unsupportedText: "不支持",
			ackText: "收到",
			handleCommand: async ({ text }) => (text === "/help" ? "命令清单" : undefined),
			send: { dataDir: dir, baseUrl: "https://ilink.example", accountId: "acc", token: "tk", maxLength: 2000, retries: 0, retryDelayMs: 0, fetchImpl },
			runAgent: async () => { ranAgent += 1; return { runId: "run-5", answer: "不该跑" }; },
		});
		const inbound = (messageId: string, text: string) => ({
			messageId,
			fromUserId: "wxid_f",
			toUserId: "bot",
			roomId: "",
			msgType: 1,
			items: [{ type: 1, text_item: { text } }],
			contextToken: "",
			raw: {},
		});

		await dispatcher(inbound("m7", "/help"));
		expect(sent).toEqual(["命令清单"]);
		expect(ranAgent).toBe(0);

		await dispatcher(inbound("m8", "你好"));
		expect(sent).toEqual(["命令清单", "收到", "不该跑"]);
		expect(ranAgent).toBe(1);
		db.close();
	});
});