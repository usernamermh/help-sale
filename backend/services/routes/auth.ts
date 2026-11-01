/**
 * 登录与账号管理路由。
 *
 *   POST   /api/v1/auth/login    账号密码换令牌(不需要令牌即可访问)
 *   GET    /api/v1/auth/me       当前身份
 *   POST   /api/v1/auth/logout   客户端丢弃令牌(服务端无会话,直接返回 ok)
 *   GET    /api/v1/auth/users    账号列表(仅管理员)
 *   POST   /api/v1/auth/users    新建账号(仅管理员)
 *   PATCH  /api/v1/auth/users/:id 改密码/角色/启停(仅管理员)
 *   DELETE /api/v1/auth/users/:id 删除账号(仅管理员)
 */
import type { FastifyInstance } from "fastify";
import { config } from "../../env.js";
import { signToken, TOKEN_PREFIX } from "../auth.js";
import { createUser, deleteUser, getUserByUsername, listUsers, updateUser, verifyPassword, type UserRole } from "../../integrations_pi/tables/agents/users.js";
import { requireAdmin, type RouteDeps } from "./helpers.js";

function roleOf(value: unknown): UserRole {
	return String(value ?? "") === "admin" ? "admin" : "member";
}

export function registerAuthRoutes(app: FastifyInstance, deps: RouteDeps): void {
	app.post<{ Body: { username?: string; password?: string } }>("/api/v1/auth/login", async (request, reply) => {
		if (!config.authEnabled) return reply.code(400).send({ error: "auth_disabled", message: "服务端未开启登录(auth.enabled=false)。" });
		const username = String(request.body?.username ?? "").trim();
		const password = String(request.body?.password ?? "");
		if (!username || !password) return reply.code(400).send({ error: "invalid_request", message: "username 与 password 都是必填的。" });
		const user = getUserByUsername(deps.db, request.tenantId, username);
		// 账号不存在与密码错误返回同一个提示,避免暴露账号是否存在
		if (!user || !user.enabled) return reply.code(401).send({ error: "auth_failed", message: "用户名或密码不正确。" });
		if (!verifyPassword(password, user.passwordHash)) return reply.code(401).send({ error: "auth_failed", message: "用户名或密码不正确。" });
		const token = signToken(
			{ tenantId: user.tenantId, userId: user.id, username: user.username, role: user.role },
			{ tokenTtlHours: config.authTokenTtlHours, tokenSecret: config.authTokenSecret },
		);
		return {
			token,
			tokenPrefix: TOKEN_PREFIX,
			expiresInHours: config.authTokenTtlHours,
			user: { id: user.id, username: user.username, role: user.role, tenantId: user.tenantId },
		};
	});

	app.get("/api/v1/auth/me", async (request, reply) => {
		if (!config.authEnabled) return { authEnabled: false, tenantId: request.tenantId, role: request.tenantRole ?? "member" };
		if (!request.tenantUserId) return reply.code(401).send({ error: "unauthenticated", message: "未登录。" });
		return { authEnabled: true, tenantId: request.tenantId, userId: request.tenantUserId, role: request.tenantRole ?? "member" };
	});

	app.post("/api/v1/auth/logout", async () => ({ ok: true }));

	app.get("/api/v1/auth/users", async (request, reply) => {
		if (!requireAdmin(request, reply)) return;
		return { users: listUsers(deps.db, request.tenantId).map(({ id, username, role, enabled, createdAt, updatedAt }) => ({ id, username, role, enabled, createdAt, updatedAt })) };
	});

	app.post<{ Body: { username?: string; password?: string; role?: string } }>("/api/v1/auth/users", async (request, reply) => {
		if (!requireAdmin(request, reply)) return;
		const username = String(request.body?.username ?? "").trim();
		const password = String(request.body?.password ?? "");
		if (username.length < 2) return reply.code(400).send({ error: "invalid_request", message: "username 至少 2 个字符。" });
		if (password.length < 8) return reply.code(400).send({ error: "invalid_request", message: "password 至少 8 位。" });
		if (getUserByUsername(deps.db, request.tenantId, username)) return reply.code(409).send({ error: "user_exists", message: `账号已存在:${username}` });
		const user = createUser(deps.db, { tenantId: request.tenantId, username, password, role: roleOf(request.body?.role) });
		return { id: user.id, username: user.username, role: user.role, enabled: user.enabled };
	});

	app.patch<{ Params: { id: string }; Body: { password?: string; role?: string; enabled?: boolean } }>("/api/v1/auth/users/:id", async (request, reply) => {
		if (!requireAdmin(request, reply)) return;
		const patch = request.body ?? {};
		if (patch.password !== undefined && String(patch.password).length < 8) return reply.code(400).send({ error: "invalid_request", message: "password 至少 8 位。" });
		const ok = updateUser(deps.db, request.tenantId, request.params.id, {
			password: patch.password === undefined ? undefined : String(patch.password),
			role: patch.role === undefined ? undefined : roleOf(patch.role),
			enabled: patch.enabled === undefined ? undefined : Boolean(patch.enabled),
		});
		if (!ok) return reply.code(404).send({ error: "not_found", message: "账号不存在。" });
		return { ok: true };
	});

	app.delete<{ Params: { id: string } }>("/api/v1/auth/users/:id", async (request, reply) => {
		if (!requireAdmin(request, reply)) return;
		if (request.params.id === request.tenantUserId) return reply.code(400).send({ error: "invalid_request", message: "不能删除自己当前登录的账号。" });
		const ok = deleteUser(deps.db, request.tenantId, request.params.id);
		if (!ok) return reply.code(404).send({ error: "not_found", message: "账号不存在。" });
		return { ok: true };
	});
}