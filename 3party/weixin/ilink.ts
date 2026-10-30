import { randomBytes } from "node:crypto";
import type { WeixinInbound, WeixinItem } from "./types.js";

/**
 * iLink 机器人协议的最小实现:请求头、基础信息、收发接口与错误分类。
 * 端点与字段照腾讯 iLink Bot API(getupdates / sendmessage / sendtyping / getconfig / 扫码登录)。
 */

export const ILINK_APP_ID = "bot";
export const CHANNEL_VERSION = "2.2.0";
export const ILINK_APP_CLIENT_VERSION = (2 << 16) | (2 << 8) | 0;
export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";

export const EP = {
	getUpdates: "ilink/bot/getupdates",
	sendMessage: "ilink/bot/sendmessage",
	sendTyping: "ilink/bot/sendtyping",
	getConfig: "ilink/bot/getconfig",
	getUploadUrl: "ilink/bot/getuploadurl",
	getBotQr: "ilink/bot/get_bot_qrcode",
	getQrStatus: "ilink/bot/get_qrcode_status",
} as const;

export const SESSION_EXPIRED_ERRCODE = -14;
export const RATE_LIMIT_ERRCODE = -2;

export interface IlinkResponse {
	ret?: number;
	errcode?: number;
	errmsg?: string;
	msgs?: unknown[];
	get_updates_buf?: string;
	longpolling_timeout_ms?: number;
	[key: string]: unknown;
}

export interface IlinkCallOptions {
	baseUrl: string;
	token?: string;
	timeoutMs: number;
	fetchImpl?: typeof fetch;
	/** 关闭 TLS 校验之外的额外处理:仅测试注入用 */
}

/** X-WECHAT-UIN:32 位随机数的十进制字符串再做 base64。 */
export function randomWechatUin(): string {
	const value = randomBytes(4).readUInt32BE(0);
	return Buffer.from(String(value), "utf8").toString("base64");
}

/** 请求头:token 为空时只带应用标识(扫码登录接口就不需要 token)。 */
export function ilinkHeaders(token: string | undefined): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		AuthorizationType: "ilink_bot_token",
		"X-WECHAT-UIN": randomWechatUin(),
		"iLink-App-Id": ILINK_APP_ID,
		"iLink-App-ClientVersion": String(ILINK_APP_CLIENT_VERSION),
	};
	if (token) headers.Authorization = `Bearer ${token}`;
	return headers;
}

function timeoutSignal(ms: number): AbortSignal {
	return AbortSignal.timeout(Math.max(1, Math.floor(ms)));
}

async function readJson(response: Response, label: string): Promise<IlinkResponse> {
	const text = await response.text();
	if (!response.ok) throw new Error(`iLink ${label} HTTP ${response.status}: ${text.slice(0, 200)}`);
	try {
		return JSON.parse(text) as IlinkResponse;
	} catch {
		throw new Error(`iLink ${label} 返回非 JSON: ${text.slice(0, 200)}`);
	}
}

/** POST 一个业务请求:自动补 base_info,统一超时与错误。 */
export async function apiPost(
	options: IlinkCallOptions & { endpoint: string; payload: Record<string, unknown> },
): Promise<IlinkResponse> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const url = `${options.baseUrl.replace(/\/+$/, "")}/${options.endpoint}`;
	const body = JSON.stringify({ ...options.payload, base_info: { channel_version: CHANNEL_VERSION } });
	const response = await fetchImpl(url, {
		method: "POST",
		headers: ilinkHeaders(options.token),
		body,
		signal: timeoutSignal(options.timeoutMs),
	});
	return readJson(response, options.endpoint);
}

/** GET:扫码登录相关接口没有 token。 */
export async function apiGet(
	options: IlinkCallOptions & { endpoint: string },
): Promise<IlinkResponse> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const url = `${options.baseUrl.replace(/\/+$/, "")}/${options.endpoint}`;
	const response = await fetchImpl(url, {
		method: "GET",
		headers: {
			"iLink-App-Id": ILINK_APP_ID,
			"iLink-App-ClientVersion": String(ILINK_APP_CLIENT_VERSION),
		},
		signal: timeoutSignal(options.timeoutMs),
	});
	return readJson(response, options.endpoint);
}

/** 长轮询拉新消息;超时按空批处理,由调用方继续下一轮。 */
export async function getUpdates(
	options: IlinkCallOptions & { syncBuf: string },
): Promise<IlinkResponse> {
	try {
		return await apiPost({
			...options,
			endpoint: EP.getUpdates,
			payload: { get_updates_buf: options.syncBuf },
		});
	} catch (error) {
		if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
			return { ret: 0, msgs: [], get_updates_buf: options.syncBuf };
		}
		throw error;
	}
}

/** 发一条文本消息;context_token 是"这一轮对话"的凭据,必须原样回带。 */
export async function sendMessage(
	options: IlinkCallOptions & {
		to: string;
		text: string;
		contextToken?: string;
		clientId: string;
	},
): Promise<IlinkResponse> {
	if (!options.text.trim()) throw new Error("sendMessage: 文本不能为空");
	const message: Record<string, unknown> = {
		from_user_id: "",
		to_user_id: options.to,
		client_id: options.clientId,
		message_type: 2,
		message_state: 2,
		item_list: [{ type: 1, text_item: { text: options.text } }],
	};
	if (options.contextToken) message.context_token = options.contextToken;
	return apiPost({ ...options, endpoint: EP.sendMessage, payload: { msg: message } });
}

/** 正在输入的状态提示;typing_ticket 来自 getconfig。 */
export async function sendTyping(
	options: IlinkCallOptions & { to: string; typingTicket: string; status: number },
): Promise<IlinkResponse> {
	return apiPost({
		...options,
		endpoint: EP.sendTyping,
		payload: { ilink_user_id: options.to, typing_ticket: options.typingTicket, status: options.status },
	});
}

/** 取会话配置(含 typing_ticket)。 */
export async function getConfig(
	options: IlinkCallOptions & { userId: string; contextToken?: string },
): Promise<IlinkResponse> {
	const payload: Record<string, unknown> = { ilink_user_id: options.userId };
	if (options.contextToken) payload.context_token = options.contextToken;
	return apiPost({ ...options, endpoint: EP.getConfig, payload });
}

/** -14,或 -2 + "unknown error",都表示 context_token 失效。 */
export function isSessionExpired(response: IlinkResponse | undefined): boolean {
	if (!response) return false;
	const ret = response.ret;
	const errcode = response.errcode;
	const expired = ret === SESSION_EXPIRED_ERRCODE || errcode === SESSION_EXPIRED_ERRCODE;
	if (expired) return true;
	const unknownError = String(response.errmsg ?? "").toLowerCase() === "unknown error";
	return unknownError && (ret === RATE_LIMIT_ERRCODE || errcode === RATE_LIMIT_ERRCODE);
}

export function isRateLimited(response: IlinkResponse | undefined): boolean {
	if (!response) return false;
	if (isSessionExpired(response)) return false;
	return response.ret === RATE_LIMIT_ERRCODE || response.errcode === RATE_LIMIT_ERRCODE;
}

/** 把 iLink 的 ret/errcode/errmsg 拼成一句可读的错误。 */
export function describeError(response: IlinkResponse | undefined, fallback = "unknown error"): string {
	if (!response) return fallback;
	const errmsg = response.errmsg ?? response.msg ?? fallback;
	return `ret=${response.ret ?? 0} errcode=${response.errcode ?? 0} errmsg=${String(errmsg)}`;
}

export function isSuccess(response: IlinkResponse | undefined): boolean {
	if (!response) return false;
	const ret = response.ret ?? 0;
	const errcode = response.errcode ?? 0;
	return ret === 0 && errcode === 0;
}

/** 把 getupdates 里的一条原始消息归一化。 */
export function toInbound(raw: Record<string, unknown>): WeixinInbound {
	const items = Array.isArray(raw.item_list) ? (raw.item_list as WeixinItem[]) : [];
	return {
		messageId: String(raw.message_id ?? "").trim(),
		fromUserId: String(raw.from_user_id ?? "").trim(),
		toUserId: String(raw.to_user_id ?? "").trim(),
		roomId: String(raw.room_id ?? raw.chat_room_id ?? "").trim(),
		msgType: Number(raw.msg_type ?? 0),
		items,
		contextToken: String(raw.context_token ?? "").trim(),
		raw,
	};
}