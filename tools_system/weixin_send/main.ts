import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../../backend/env.js";
import { readAccount } from "../../3party/weixin/store.js";
import { sendWeixinText } from "../../3party/weixin/send.js";
import { listWeixinUsers } from "../../3party/weixin/tables.js";

/**
 * 微信出站工具:让 agent 主动给人发微信,和收消息回复走同一套发送实现。
 * 账号来自 weixin 配置,或扫码登录后落盘的 data/weixin/account.json。
 */

interface ToolContext {
	db: unknown;
	tenantId: string;
}

interface Params {
	action?: "send" | "list";
	to?: string;
	text?: string;
}

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function dataDir(): string {
	return path.isAbsolute(config.dataDir) ? config.dataDir : path.join(repoRoot, config.dataDir);
}

function reply(text: string, details?: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text }], details: details ?? null };
}

function currentAccount() {
	if (config.weixinAccountId && config.weixinToken) {
		return { accountId: config.weixinAccountId, token: config.weixinToken, baseUrl: config.weixinBaseUrl, userId: "", savedAt: "" };
	}
	return readAccount(dataDir());
}

export async function execute(ctx: ToolContext, params: Params) {
	if (!config.weixinEnabled) {
		return reply("微信通道未启用(help-sale.config.yaml 的 weixin.enabled=false),无法发送。");
	}
	const action = params?.action ?? "send";

	if (action === "list") {
		const users = listWeixinUsers(ctx.db as never, config.weixinTenantId, 20).map((user) => ({
			openid: user.openid,
			boundKind: user.boundKind,
			boundId: user.boundId,
			lastActiveAt: user.lastActiveAt,
		}));
		if (users.length === 0) return reply("还没有联系过系统的微信用户。", { users });
		return reply(users.map((user) => `${user.openid}${user.boundId ? `(已绑定 ${user.boundKind}:${user.boundId})` : ""}`).join("\n"), { users });
	}

	const to = String(params?.to ?? "").trim();
	const text = String(params?.text ?? "").trim();
	if (!to || !text) return reply("action=send 时,to 与 text 都是必填。");

	const account = currentAccount();
	if (!account) return reply("尚未登录微信:先在控制台调用 POST /api/v1/weixin/login 扫码登录。");

	const result = await sendWeixinText(
		{
			dataDir: dataDir(),
			baseUrl: account.baseUrl || config.weixinBaseUrl,
			accountId: account.accountId,
			token: account.token,
			maxLength: config.weixinMaxMessageLength,
			retries: config.weixinSendRetries,
			retryDelayMs: config.weixinSendRetryDelayMs,
		},
		to,
		text,
	);
	if (!result.ok) return reply(`发送失败:${result.error ?? "unknown"}`, { ok: false, chunks: result.chunks });
	return reply(`已发送(${result.chunks} 条)`, { ok: true, chunks: result.chunks });
}