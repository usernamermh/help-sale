import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import type { LoginTicket } from "./login.js";
import type { WeixinSendResult } from "./types.js";
import { bindWeixinUser, listWeixinMessages, listWeixinUsers, getWeixinUser } from "./tables.js";
import { config } from "../../backend/env.js";
import type { WeixinTenantRuntime, WeixinTenantStatus } from "./index.js";

/**
 * 微信通道的 HTTP 接口。
 *   - 门店层(/api/v1/weixin/*):用当前登录门店的身份,只能操作本店那个机器人;
 *   - 平台层(/api/v1/platform/weixin):总部只看"哪些门店登录了/掉线了",看不到消息内容。
 */

export interface WeixinContext {
	enabled: boolean;
	db: DatabaseSync;
	/** 按门店取运行时(门店层用 request.tenantId) */
	runtime(tenantId: string): WeixinTenantRuntime;
	/** 平台层:所有已注册门店的登录状态 */
	statusAll(): WeixinTenantStatus[];
	stop(tenantId?: string): void;
}

const BIND_KINDS = new Set(["sales", "customers"]);

export function registerWeixinRoutes(app: FastifyInstance, ctx: WeixinContext): void {
	/** 本店状态。 */
	app.get("/api/v1/weixin/status", async (request) => {
		const status = ctx.runtime(request.tenantId).status();
		// 前端还读这两个开关,一起回给它(门店自己的状态里就有)
		return { ...status, autoReply: config.weixinAutoReply, commandsEnabled: config.weixinCommandsEnabled };
	});

	// 同时接受 GET 与 POST:浏览器直接打开就能拿到二维码,脚本调用也不用先凑一个 JSON body
	app.route({
		method: ["GET", "POST"],
		url: "/api/v1/weixin/login",
		handler: async (request, reply) => {
			if (!ctx.enabled) return reply.code(400).send({ error: "weixin_disabled", message: "微信通道未启用（weixin.enabled=false）。" });
			try {
				return await ctx.runtime(request.tenantId).startLogin();
			} catch (error) {
				return reply.code(502).send({ error: "weixin_login_failed", message: error instanceof Error ? error.message : String(error) });
			}
		},
	});

	app.get<{ Params: { id: string } }>("/api/v1/weixin/login/:id", async (request, reply) => {
		try {
			return await ctx.runtime(request.tenantId).pollLogin(request.params.id);
		} catch (error) {
			return reply.code(400).send({ error: "weixin_login_poll_failed", message: error instanceof Error ? error.message : String(error) });
		}
	});

	app.post("/api/v1/weixin/logout", async (request) => {
		ctx.runtime(request.tenantId).logout();
		return { ok: true };
	});

	app.post<{ Body: { to?: string; text?: string } }>("/api/v1/weixin/send", async (request, reply) => {
		const to = String(request.body?.to ?? "").trim();
		const text = String(request.body?.text ?? "").trim();
		if (!to || !text) return reply.code(400).send({ error: "invalid_request", message: "to 与 text 都是必填的。" });
		if (!ctx.enabled) return reply.code(400).send({ error: "weixin_disabled", message: "微信通道未启用（weixin.enabled=false）。" });
		const result = await ctx.runtime(request.tenantId).sendText(to, text);
		if (!result.ok) return reply.code(502).send({ error: "weixin_send_failed", message: result.error ?? "发送失败。", chunks: result.chunks });
		return result;
	});

	app.get<{ Querystring: { limit?: string } }>("/api/v1/weixin/users", async (request) => {
		const limit = Number(request.query?.limit ?? 20);
		const users = listWeixinUsers(ctx.db, request.tenantId, Number.isFinite(limit) ? limit : 20).map((user) => ({
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
			return reply.code(400).send({ error: "invalid_request", message: "openid、kind(sales|customers)、id 都是必填的。" });
		}
		if (!getWeixinUser(ctx.db, request.tenantId, openid)) {
			return reply.code(404).send({ error: "weixin_user_not_found", message: "该联系人还没跟本店机器人说过话。" });
		}
		const ok = bindWeixinUser(ctx.db, request.tenantId, openid, kind, boundId);
		if (!ok) return reply.code(400).send({ error: "bind_failed", message: "绑定失败。" });
		return { ok: true };
	});

	app.get<{ Querystring: { limit?: string } }>("/api/v1/weixin/messages", async (request) => {
		const limit = Number(request.query?.limit ?? 50);
		return { messages: listWeixinMessages(ctx.db, request.tenantId, Number.isFinite(limit) ? limit : 50) };
	});

	/**
	 * 平台层:各门店微信登录状态(只给状态,不给消息内容)。
	 * 走 /api/v1/platform/* 前缀,平台令牌之外的门店令牌会被 preHandler 拒掉。
	 */
	app.get("/api/v1/platform/weixin", async () => {
		const accounts = ctx.statusAll();
		return {
			enabled: ctx.enabled,
			accounts,
			summary: {
				stores: accounts.length,
				loggedIn: accounts.filter((a) => a.loggedIn).length,
				polling: accounts.filter((a) => a.polling).length,
				withError: accounts.filter((a) => a.lastError).map((a) => ({ tenantId: a.tenantId, lastError: a.lastError })),
			},
		};
	});
}