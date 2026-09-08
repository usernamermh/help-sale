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