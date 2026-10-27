import { afterEach, describe, expect, it } from "vitest";
import { buildConversationText, openSessionStore, tmpDataDir, cleanupDataDir, type SessionStore } from "./sessions.js";

let store: SessionStore | undefined;
let dir: string | undefined;

afterEach(async () => {
	if (store) await store.close();
	if (dir) cleanupDataDir(dir);
});

describe("session store", () => {
	it("创建会话并写回消息", async () => {
		dir = tmpDataDir("sess");
		store = openSessionStore(dir);
		const { session, conversationId } = await store.createConversation();
		expect(conversationId).toBeTruthy();

		const text = buildConversationText([
			{ role: "customer", content: "太贵了" },
			{ role: "sales", content: "您好,聊聊预算?" },
		]);
		expect(text).toContain("客户[customer]");
		await import("./sessions.js").then((m) => m.appendUserMessage(session, text));

		const leaf = await session.getLeafId();
		expect(leaf).toBeTruthy();
		const entries = await session.findEntries();
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ type: "message" });
		expect((entries[0] as { message: { role: string } }).message.role).toBe("user");
	});

	it("会话数据库文件生成", async () => {
		dir = tmpDataDir("sess-file");
		const dbPath = dir + "/pi-sessions.db";
		store = openSessionStore(dir, dbPath);
		await store.createConversation();
		const { existsSync } = await import("node:fs");
		expect(existsSync(dbPath)).toBe(true);
	});
});
describe("fetchTranscript", () => {
	it("从会话回读对话文本", async () => {
		const s = tmpDataDir("transcript");
		const st = openSessionStore(s);
		try {
			const { session } = await st.createConversation();
			await import("./sessions.js").then((m) => m.appendUserMessage(session, "第一轮:客户提到的内容"));
			const transcript = await import("./sessions.js").then((m) => m.fetchTranscript(session, 50));
			expect(transcript).toHaveLength(1);
			expect(transcript[0].role).toBe("customer");
			expect(transcript[0].content).toContain("客户提到的内容");
		} finally {
			await st.close();
			cleanupDataDir(s);
		}
	});
});
