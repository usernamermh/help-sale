/**
 * 登录与令牌。
 *
 * 设计:
 *   1) 令牌是无状态 HMAC 签名串(hsu1.<payload>.<sig>),密钥来自密钥文件(auth.tokenSecret),
 *      注销 = 客户端丢弃令牌(服务端不存会话);
 *   2) 载荷里带 tenantId / userId / role / exp,租户由**令牌**决定 —— 请求头声明的租户不能覆盖它;
 *   3) 校验签名与有效期之外,还回查一次账号是否仍存在且启用(停用账号立刻失效)。
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getUserById, type UserRole } from "../integrations_pi/tables/agents/users.js";
import { getPlatformAdminById } from "../integrations_pi/tables/agents/platform-admins.js";

export const TOKEN_PREFIX = "hsu1";

export interface AuthSettings {
	enabled: boolean;
	tokenTtlHours: number;
	tokenSecret: string;
}

/** 令牌作用域:tenant=门店账号;platform=总部平台管理员(不带租户,只能访问平台接口) */
export type AuthScope = "tenant" | "platform";

export interface AuthIdentity {
	scope: AuthScope;
	tenantId: string;
	userId: string;
	username: string;
	role: UserRole;
	/** 过期时间(毫秒时间戳) */
	exp: number;
}

function base64url(input: Buffer | string): string {
	return Buffer.from(input).toString("base64url");
}

function sign(payload: string, secret: string): string {
	return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** 签发令牌。 */
export function signToken(
	identity: Omit<AuthIdentity, "exp">,
	settings: { tokenTtlHours: number; tokenSecret: string },
	nowMs = Date.now(),
): string {
	const exp = nowMs + Math.max(1, settings.tokenTtlHours) * 3600_000;
	const payload = base64url(JSON.stringify({ ...identity, exp }));
	const body = `${TOKEN_PREFIX}.${payload}`;
	return `${body}.${sign(body, settings.tokenSecret)}`;
}

/** 校验令牌:格式、签名、有效期任何一项不合格都返回 error。 */
export function verifyToken(
	token: string,
	settings: { tokenSecret: string },
	nowMs = Date.now(),
): { identity?: AuthIdentity; error?: string } {
	const parts = String(token ?? "").split(".");
	if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return { error: "令牌格式不正确" };
	const body = `${parts[0]}.${parts[1]}`;
	const expected = Buffer.from(sign(body, settings.tokenSecret));
	const actual = Buffer.from(parts[2]);
	if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return { error: "令牌签名不匹配" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
	} catch {
		return { error: "令牌内容无法解析" };
	}
	const value = parsed as Partial<AuthIdentity>;
	const scope: AuthScope = value?.scope === "platform" ? "platform" : "tenant";
	if (!value?.userId || !value?.exp) return { error: "令牌缺少必要字段" };
	// 门店令牌必须带租户;平台令牌不带租户(它不是任何门店的人)
	if (scope === "tenant" && !value?.tenantId) return { error: "令牌缺少租户" };
	if (Number(value.exp) <= nowMs) return { error: "登录已过期,请重新登录" };
	return {
		identity: {
			scope,
			tenantId: String(value.tenantId ?? ""),
			userId: String(value.userId),
			username: String(value.username ?? ""),
			role: value.role === "admin" ? "admin" : "member",
			exp: Number(value.exp),
		},
	};
}

/** 从请求头取 Bearer 令牌(没有就返回空串)。 */
export function extractBearer(headers: Record<string, string | string[] | undefined>): string {
	const raw = headers.authorization;
	const value = Array.isArray(raw) ? String(raw[0] ?? "") : String(raw ?? "");
	const match = /^Bearer\s+(.+)$/i.exec(value.trim());
	return match ? match[1].trim() : "";
}

/** 判断一个 Bearer 值是不是本系统的登录令牌(用于与集成方 API Key 区分)。 */
export function looksLikeToken(value: string): boolean {
	return String(value ?? "").startsWith(`${TOKEN_PREFIX}.`);
}

/**
 * 解析请求身份:先按令牌,再回查账号是否仍启用。
 * 返回 error 表示"带了令牌但不认",调用方应直接 401,而不是退回请求头。
 */
export function resolveIdentity(
	db: DatabaseSync,
	headers: Record<string, string | string[] | undefined>,
	settings: AuthSettings,
	nowMs = Date.now(),
): { identity?: AuthIdentity; error?: string; hasToken?: boolean } {
	const bearer = extractBearer(headers);
	const token = looksLikeToken(bearer) ? bearer : String(headers["x-auth-token"] ?? "");
	if (!token) return { hasToken: false };
	const verified = verifyToken(token, settings, nowMs);
	if (!verified.identity) return { error: verified.error, hasToken: true };
	if (verified.identity.scope === "platform") {
		const admin = getPlatformAdminById(db, verified.identity.userId);
		if (!admin || !admin.enabled) return { error: "平台账号不存在或已停用", hasToken: true };
		return { identity: { ...verified.identity, username: admin.username, role: "admin" }, hasToken: true };
	}
	const user = getUserById(db, verified.identity.tenantId, verified.identity.userId);
	if (!user || !user.enabled) return { error: "账号不存在或已停用", hasToken: true };
	return { identity: { ...verified.identity, username: user.username, role: user.role }, hasToken: true };
}