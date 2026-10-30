import { ITEM_TEXT, type WeixinItem } from "./types.js";

/** 微信侧纯文本渲染:去掉 Markdown 记号,表格拆成逐行,链接保留地址。 */

const FENCE_RE = /^\s*```/;
const HEADING_RE = /^\s{0,3}#{1,6}\s+/;
const TABLE_RULE_RE = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/;

function tableRowToLine(line: string): string {
	const cells = line
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split("|")
		.map((cell) => cell.trim())
		.filter((cell) => cell.length > 0);
	return cells.join(" · ");
}

/** Markdown → 微信可读纯文本(不改变信息内容,只换排版)。 */
export function toPlainText(markdown: string): string {
	const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
	const out: string[] = [];
	let inFence = false;
	for (const line of lines) {
		if (FENCE_RE.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) {
			out.push(line);
			continue;
		}
		if (TABLE_RULE_RE.test(line)) continue;
		if (/^\s*\|.*\|\s*$/.test(line)) {
			out.push(tableRowToLine(line));
			continue;
		}
		let text = line.replace(HEADING_RE, "");
		text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt: string, url: string) => (alt ? `${alt} (${url})` : url));
		text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) => (label === url ? url : `${label} (${url})`));
		text = text.replace(/`{1,3}([^`]+)`{1,3}/g, "$1");
		text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
		text = text.replace(/__([^_]+)__/g, "$1");
		text = text.replace(/^\s*[-*+]\s+/, "· ");
		out.push(text);
	}
	return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** 按段落 → 行 → 句子 → 硬切的顺序分片,每片不超过 max 个字符。 */
export function splitText(content: string, max: number): string[] {
	const text = String(content ?? "").replace(/\r\n?/g, "\n").trim();
	const limit = Math.max(1, Math.floor(max));
	if (!text) return [];
	if (text.length <= limit) return [text];

	const chunks: string[] = [];
	const push = (piece: string) => {
		const value = piece.replace(/\s+$/, "");
		if (value.trim()) chunks.push(value);
	};
	let buffer = "";
	const flush = () => {
		if (buffer) push(buffer);
		buffer = "";
	};
	const add = (piece: string) => {
		if (!piece) return;
		if (piece.length > limit) {
			// 单句仍超长:按字符硬切
			let rest = piece;
			while (rest.length > limit) {
				push(rest.slice(0, limit));
				rest = rest.slice(limit);
			}
			buffer += rest;
			return;
		}
		if (buffer.length + piece.length > limit) flush();
		buffer += piece;
	};

	for (const paragraph of text.split(/\n{2,}/)) {
		const withBreak = paragraph + "\n\n";
		if (withBreak.length <= limit - buffer.length) {
			buffer += withBreak;
			continue;
		}
		for (const line of paragraph.split("\n")) {
			if (line.length + 1 <= limit) {
				add(line + "\n");
				continue;
			}
			for (const sentence of line.split(/(?<=[。!?;.!?])/)) add(sentence);
		}
		add("\n");
	}
	flush();
	return chunks.length > 0 ? chunks : [text];
}

/** 从 item_list 里取正文。 */
export function extractText(items: WeixinItem[] | undefined): string {
	if (!Array.isArray(items)) return "";
	const parts: string[] = [];
	for (const item of items) {
		if (Number(item?.type) !== ITEM_TEXT) continue;
		const value = item?.text_item?.text;
		if (typeof value === "string" && value.trim()) parts.push(value);
	}
	return parts.join("\n").trim();
}

/** 群聊判定:带 room_id,或 to_user_id 指向别人且 msg_type=1。 */
export function guessChatType(input: { roomId?: string; toUserId?: string; msgType?: number }, accountId: string): { chatType: "dm" | "group"; chatId: string } {
	const roomId = String(input.roomId ?? "").trim();
	const toUserId = String(input.toUserId ?? "").trim();
	const isGroup = Boolean(roomId) || Boolean(toUserId && accountId && toUserId !== accountId && Number(input.msgType) === 1);
	if (isGroup) return { chatType: "group", chatId: roomId || toUserId };
	return { chatType: "dm", chatId: toUserId };
}

/** 日志里用的脱敏 id:保留首尾便于比对。 */
export function maskId(value: string | undefined, head = 6, tail = 4): string {
	const text = String(value ?? "");
	if (!text) return "";
	if (text.length <= head + tail) return `${text.slice(0, 2)}***`;
	return `${text.slice(0, head)}***${text.slice(-tail)}`;
}