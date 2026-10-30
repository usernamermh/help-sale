import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import type { LoginTicket } from "./login.js";
import type { WeixinSendResult } from "./types.js";
import { bindWeixinUser, listWeixinMessages, listWeixinUsers, getWeixinUser } from "./tables.js";

/** 微信通道的 HTTP 接口:状态、扫码登录、主动发送、绑定与审计查询。 */

export interface WeixinContext {
	enabled: boolean;
	tenantId: string;
	db: DatabaseSync;
	status(): Record<string, unknown>;
	startLogin(): Promise<LoginTicket>;
	pollLogin(id: string): Promise<LoginTicket>;
	sendText(to: string, text: string): Promise<WeixinSendResult>;
	logout(): void;
	stop(): void;
}

const BIND_KINDS = new Set(["sales", "customers"]);

export function registerWeixinRoutes(app: FastifyInstance, ctx: WeixinContext): void {
	app.get("/api/v1/weixin/status", async () => ctx.status());

	// 同时接受 GET 与 POST:浏览器直接打开就能拿到二维码,脚本调用也不用先凑一个 JSON body
	app.route({
		method: ["GET", "POST"],
		url: "/api/v1/weixin/login",
		handler: async (_request, reply) => {
			if (!ctx.enabled) return reply.code(400).send({ error: "weixin_disabled", message: "微信通道未启用（weixin.enabled=false）" });
			try {
				return await ctx.startLogin();
			} catch (error) {
				return reply.code(502).send({ error: "weixin_login_failed", message: error instanceof Error ? error.message : String(error) });
			}
		},
	});

	app.get<{ Params: { id: string } }>("/api/v1/weixin/login/:id", async (request, reply) => {
		try {
			return await ctx.pollLogin(request.params.id);
		} catch (error) {
			return reply.code(400).send({ error: "weixin_login_poll_failed", message: error instanceof Error ? error.message : String(error) });
		}
	});

	app.post("/api/v1/weixin/logout", async () => {
		ctx.logout();
		return { ok: true };
	});

	app.post<{ Body: { to?: string; text?: string } }>("/api/v1/weixin/send", async (request, reply) => {
		const to = String(request.body?.to ?? "").trim();
		const text = String(request.body?.text ?? "").trim();
		if (!to || !text) return reply.code(400).send({ error: "invalid_request", message: "to 与 text 都是必填的。" });
		if (!ctx.enabled) return reply.code(400).send({ error: "weixin_disabled", message: "微信通道未启用（weixin.enabled=false）" });
		const result = await ctx.sendText(to, text);
		if (!result.ok) return reply.code(502).send({ error: "weixin_send_failed", message: result.error ?? "发送失败。", chunks: result.chunks });
		return result;
	});

	app.get<{ Querystring: { limit?: string } }>("/api/v1/weixin/users", async (request) => {
		const limit = Number(request.query?.limit ?? 20);
		const users = listWeixinUsers(ctx.db, ctx.tenantId, Number.isFinite(limit) ? limit : 20).map((user) => ({
			openid: user.openid,
			boundKind: user.boundKind,
			boundId: user.boundId,
			threadId: user.threadId,
			lastActiveAt: user.lastActiveAt,
			createdAt: user.createdAt,
		}));
		return { users };
	});

	app.post<{ Body: { openid?: string; kind?: string; id?: string } }>("/api/v1/weixin/bind", async (request, reply) => {
		const openid = String(request.body?.openid ?? "").trim();
		const kind = String(request.body?.kind ?? "").trim();
		const boundId = String(request.body?.id ?? "").trim();
		if (!openid || !BIND_KINDS.has(kind) || !boundId) {
			return reply.code(400).send({ error: "invalid_request", message: "openid、kind（sales|customers）、id 都是必填的。" });
		}
		if (!getWeixinUser(ctx.db, ctx.tenantId, openid)) {
			return reply.code(404).send({ error: "weixin_user_not_found", message: "该微信联系人还没有给系统发过消息。" });
		}
		const ok = bindWeixinUser(ctx.db, ctx.tenantId, openid, kind, boundId);
		return { ok, openid, kind, id: boundId };
	});

	app.get<{ Querystring: { limit?: string } }>("/api/v1/weixin/messages", async (request) => {
		const limit = Number(request.query?.limit ?? 50);
		return { messages: listWeixinMessages(ctx.db, ctx.tenantId, Number.isFinite(limit) ? limit : 50) };
	});
}