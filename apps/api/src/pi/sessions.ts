import path from "node:path";
import fs from "node:fs";
import { mkdirSync, rmSync } from "node:fs";
import { createNodeSqliteFactory, SqliteSessionRepository } from "@earendil-works/pi-session-backend-sqlite-node";

export interface ConversationMessage {
	role: "customer" | "sales" | "other";
	content: string;
}

export function buildConversationText(messages: ConversationMessage[]): string {
	return messages
		.map((m, index) => {
			const speaker = m.role === "customer" ? "客户" : m.role === "sales" ? "销售" : "其他";
			return `${index + 1}. ${speaker}[${m.role}]: ${m.content}`;
		})
		.join("\n");
}

export interface SessionStore {
	createConversation(): Promise<{ session: import("@earendil-works/pi-agent-core").Session<any>; conversationId: string }>;
	close(): Promise<void>;
}

export function openSessionStore(dataDir: string, databasePath?: string): SessionStore {
	mkdirSync(dataDir, { recursive: true });
	const dbPath = databasePath ?? path.join(dataDir, "pi-sessions.db");
	const repo = new SqliteSessionRepository({
		env: {
			absolutePath: async (p: string) => ({ ok: true as const, value: path.resolve(dataDir, p) }),
			exists: async (p: string) => ({ ok: true as const, value: fs.existsSync(p) }),
			createDir: async (p: string) => {
				fs.mkdirSync(p, { recursive: true });
				return { ok: true as const, value: undefined as void };
			},
		},
		sqlite: createNodeSqliteFactory(),
		databasePath: dbPath,
	});

	return {
		async createConversation() {
			const session = await repo.create({ cwd: dataDir, metadata: { app: "sales-copilot" } });
			const { id } = await session.getMetadata();
			return { session, conversationId: id };
		},
		async close() {
			await repo.close();
		},
	};
}

export async function appendUserMessage(session: import("@earendil-works/pi-agent-core").Session<any>, content: string) {
	await session.appendMessage({ role: "user", content, timestamp: Date.now() });
}

export function tmpDataDir(prefix: string): string {
	return path.join(process.cwd(), ".tmp", `${prefix}-${Date.now()}`);
}

export function cleanupDataDir(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
}