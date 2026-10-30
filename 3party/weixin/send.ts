import { randomUUID } from "node:crypto";
import { dropContextToken, readContextToken } from "./store.js";
import { describeError, isRateLimited, isSessionExpired, sendMessage, type IlinkResponse } from "./ilink.js";
import { splitText, toPlainText } from "./text.js";
import type { WeixinSendResult } from "./types.js";

export interface WeixinSendOptions {
	dataDir: string;
	baseUrl: string;
	accountId: string;
	token: string;
	maxLength: number;
	retries: number;
	retryDelayMs: number;
	fetchImpl?: typeof fetch;
	sleepImpl?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 把一段内容发回微信:先用微信可读的纯文本渲染,再按长度分片逐条发送。
 * context_token 失效会自动去掉重试一次;-2 限流按 3 倍间隔退避。
 */
export async function sendWeixinText(
	options: WeixinSendOptions,
	to: string,
	content: string,
): Promise<WeixinSendResult> {
	const plain = toPlainText(content);
	if (!plain) return { ok: false, chunks: 0, error: "内容为空。" };
	const chunks = splitText(plain, options.maxLength);
	const sleep = options.sleepImpl ?? defaultSleep;
	let sent = 0;
	for (const chunk of chunks) {
		try {
			await sendChunk(options, to, chunk, sleep);
			sent += 1;
		} catch (error) {
			return { ok: false, chunks: sent, error: error instanceof Error ? error.message : String(error) };
		}
	}
	return { ok: true, chunks: sent };
}

async function sendChunk(
	options: WeixinSendOptions,
	to: string,
	text: string,
	sleep: (ms: number) => Promise<void>,
): Promise<void> {
	const attempts = Math.max(0, Math.floor(options.retries)) + 1;
	let contextToken = readContextToken(options.dataDir, options.accountId, to);
	let droppedToken = false;
	let lastError = "发送失败。";
	for (let attempt = 0; attempt < attempts; attempt++) {
		let response: IlinkResponse | undefined;
		try {
			response = await sendMessage({
				baseUrl: options.baseUrl,
				token: options.token,
				timeoutMs: 15_000,
				fetchImpl: options.fetchImpl,
				to,
				text,
				contextToken,
				clientId: randomUUID(),
			});
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
			if (attempt < attempts - 1) await sleep(options.retryDelayMs * (attempt + 1));
			continue;
		}
		const ret = response.ret ?? 0;
		const errcode = response.errcode ?? 0;
		if (ret === 0 && errcode === 0) return;

		lastError = describeError(response);
		if (isSessionExpired(response) && contextToken && !droppedToken) {
			droppedToken = true;
			contextToken = undefined;
			dropContextToken(options.dataDir, options.accountId, to);
			continue;
		}
		if (isRateLimited(response) && attempt < attempts - 1) {
			await sleep(options.retryDelayMs * 3);
			continue;
		}
		if (attempt < attempts - 1) await sleep(options.retryDelayMs * (attempt + 1));
	}
	throw new Error(lastError);
}