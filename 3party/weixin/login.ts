import { randomUUID } from "node:crypto";
import { EP, apiGet } from "./ilink.js";
import { writeAccount } from "./store.js";
import type { WeixinAccount } from "./types.js";

/** 扫码登录:取二维码 → 轮询状态 → 确认后把 accountId/token 落盘。 */

export type LoginStatus = "wait" | "scaned" | "confirmed" | "expired" | "failed";

export interface LoginTicket {
	id: string;
	qrcode: string;
	/** 微信可识别的二维码内容(liteapp 链接),前端直接渲染成二维码即可 */
	qrcodeUrl: string;
	status: LoginStatus;
	baseUrl: string;
	accountId?: string;
	error?: string;
	createdAt: number;
	updatedAt: number;
}

export interface LoginManagerOptions {
	dataDir: string;
	baseUrl: string;
	botType: string;
	/** 单个 HTTP 请求超时 */
	timeoutMs: number;
	/** 一张二维码的存活时间 */
	ticketTtlMs: number;
	fetchImpl?: typeof fetch;
	now?: () => number;
}

export interface LoginManager {
	start(): Promise<LoginTicket>;
	poll(id: string): Promise<LoginTicket>;
	get(id: string): LoginTicket | undefined;
}

export function createLoginManager(options: LoginManagerOptions): LoginManager {
	const tickets = new Map<string, LoginTicket>();
	const now = options.now ?? Date.now;

	const sweep = () => {
		const cutoff = now() - options.ticketTtlMs;
		for (const [id, ticket] of tickets) {
			if (ticket.updatedAt < cutoff) tickets.delete(id);
		}
	};

	const save = (ticket: LoginTicket): LoginTicket => {
		tickets.set(ticket.id, ticket);
		return ticket;
	};

	return {
		async start(): Promise<LoginTicket> {
			sweep();
			const response = await apiGet({
				baseUrl: options.baseUrl,
				timeoutMs: options.timeoutMs,
				fetchImpl: options.fetchImpl,
				endpoint: `${EP.getBotQr}?bot_type=${encodeURIComponent(options.botType)}`,
			});
			const qrcode = String(response.qrcode ?? "").trim();
			const qrcodeUrl = String(response.qrcode_img_content ?? "").trim();
			if (!qrcode) throw new Error(`取二维码失败: ${JSON.stringify(response).slice(0, 200)}`);
			const stamp = now();
			return save({
				id: randomUUID(),
				qrcode,
				qrcodeUrl: qrcodeUrl || qrcode,
				status: "wait",
				baseUrl: options.baseUrl,
				createdAt: stamp,
				updatedAt: stamp,
			});
		},

		async poll(id: string): Promise<LoginTicket> {
			const ticket = tickets.get(id);
			if (!ticket) throw new Error("登录会话不存在或已过期,请重新获取二维码");
			if (ticket.status === "confirmed" || ticket.status === "failed") return ticket;

			const response = await apiGet({
				baseUrl: ticket.baseUrl,
				timeoutMs: options.timeoutMs,
				fetchImpl: options.fetchImpl,
				endpoint: `${EP.getQrStatus}?qrcode=${encodeURIComponent(ticket.qrcode)}`,
			});
			const status = String(response.status ?? "wait");
			ticket.updatedAt = now();

			if (status === "scaned_but_redirect") {
				const redirectHost = String(response.redirect_host ?? "").trim();
				if (redirectHost) ticket.baseUrl = `https://${redirectHost}`;
				ticket.status = "scaned";
				return ticket;
			}
			if (status === "scaned") {
				ticket.status = "scaned";
				return ticket;
			}
			if (status === "expired") {
				ticket.status = "expired";
				ticket.error = "二维码已过期,请重新获取";
				return ticket;
			}
			if (status === "confirmed") {
				const accountId = String(response.ilink_bot_id ?? "").trim();
				const token = String(response.bot_token ?? "").trim();
				if (!accountId || !token) {
					ticket.status = "failed";
					ticket.error = "登录确认但缺少账号或令牌";
					return ticket;
				}
				const account: WeixinAccount = {
					accountId,
					token,
					baseUrl: String(response.baseurl ?? ticket.baseUrl).trim() || ticket.baseUrl,
					userId: String(response.ilink_user_id ?? "").trim(),
					savedAt: new Date(now()).toISOString(),
				};
				writeAccount(options.dataDir, account);
				ticket.status = "confirmed";
				ticket.accountId = accountId;
				ticket.baseUrl = account.baseUrl;
				return ticket;
			}
			ticket.status = "wait";
			return ticket;
		},

		get(id: string): LoginTicket | undefined {
			return tickets.get(id);
		},
	};
}