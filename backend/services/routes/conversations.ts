import { config } from "../../env.js";
import { getConversation, listConversations } from "../../integrations_pi/tables/crm/conversations.js";
import { listAgentEvents } from "../../integrations_pi/tables/agents/events.js";
import { listConversationMessages as listConvMessages } from "../../integrations_pi/tables/crm/messages.js";
import type { FastifyInstance } from "fastify";
import type { RouteDeps } from "./helpers.js";

/** 会话消息行 → 前端可用载荷(原 v1 pi/business/analysis.ts 里的行映射,只服务会话原文接口) */
export function messageRowsToPayload(rows: Array<{ seq: number; speaker_role: string; speaker_name: string | null; content: string; spoken_at: string | null }>) {
	return rows.map((r) => ({ seq: r.seq, speakerRole: r.speaker_role, speakerName: r.speaker_name, content: r.content, spokenAt: r.spoken_at }));
}

// ── 以下来自 v1 services/conversation.ts(功能逻辑与路由同文件) ──
export interface ConversationMessage {
	role: "customer" | "sales" | "other";
	content: string;
	spokenAt?: string;
	speakerName?: string;
}

export interface RawMessageInput {
	role?: string;
	content: string;
	spokenAt?: string;
	speakerName?: string;
}

const CUSTOMER_RE = /^\s*(?:客户|顾客)[：:]\s*(.+)$/;
const SALES_RE = /^\s*(?:销售|我|agent|客服)[：:]\s*(.+)$/;

/**
 * 把输入的会话文本解析为结构化消息:
 * - "客户: …"/"销售: …" 前缀行按标注识别;
 * - 无前缀行按"首条客户、之后交替"启发式归属。
 */
export function parseTranscript(text: string): ConversationMessage[] {
	const out: ConversationMessage[] = [];
	let last: "customer" | "sales" = "customer";
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) continue;
		const customerMatch = line.match(CUSTOMER_RE);
		if (customerMatch) {
			out.push({ role: "customer", content: customerMatch[1].trim() });
			last = "sales";
			continue;
		}
		const salesMatch = line.match(SALES_RE);
		if (salesMatch) {
			out.push({ role: "sales", content: salesMatch[1].trim() });
			last = "customer";
			continue;
		}
		out.push({ role: last, content: line });
		last = last === "customer" ? "sales" : "customer";
	}
	return out;
}

/** 归一化 analyze 入参:messages 优先,否则解析 transcript;均无则空。 */
export function normalizeAnalyzeMessages(input: { transcript?: string; messages?: RawMessageInput[] }): ConversationMessage[] {
	if (input.messages && input.messages.length > 0) {
		return input.messages.map((m) => {
			const role = m.role === "sales" || m.role === "customer" || m.role === "other" ? m.role : "customer";
			const out: ConversationMessage = { role, content: m.content };
			if (m.spokenAt) out.spokenAt = m.spokenAt;
			if (m.speakerName) out.speakerName = m.speakerName;
			return out;
		});
	}
	return parseTranscript(input.transcript ?? "");
}

// conversations 域路由(由 v1 routes/list_for_view.ts 拆分而来)

export function registerConversationRoutes(app: FastifyInstance, deps: RouteDeps): void {
app.get<{ Params: { id: string } }>("/api/v1/conversations/:id/transcript", async (request, reply) => {
		const meta = getConversation(deps.db, request.tenantId, request.params.id);
		if (!meta) return reply.code(404).send({ error: "conversation_not_found", message: "会话不存在" });
		const customer = meta.customerId
			? (deps.db.prepare("SELECT id, key, name, phone FROM customers WHERE tenant_id = ? AND id = ?").get(request.tenantId, meta.customerId) as unknown as { id: string; key: string; name: string | null; phone: string | null } | undefined)
			: undefined;
		return {
			conversation: meta,
			customer: customer ?? null,
			transcript: messageRowsToPayload(listConvMessages(deps.db, request.tenantId, meta.id)),
		};
	});

app.get<{ Querystring: { limit?: string } }>("/api/v1/conversations", async (request) => {
		const limit = Math.min(Number(request.query.limit ?? config.conversationsLimit) || config.conversationsLimit, 100);
		return { conversations: listConversations(deps.db, request.tenantId, limit) };
	});

app.get<{ Params: { conversationId: string } }>("/api/v1/conversations/:conversationId/timeline", async (request) => {
		const events = listAgentEvents(deps.db, request.tenantId, request.params.conversationId);
		return {
			conversationId: request.params.conversationId,
			events: events.map((e) => ({
				seq: e.seq,
				type: e.eventType,
				toolName: e.toolName,
				payload: e.payloadJson ? (JSON.parse(e.payloadJson) as unknown) : null,
				createdAt: e.createdAt,
			})),
		};
	});
}
