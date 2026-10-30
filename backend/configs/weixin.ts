import { bool, num, str, strList } from "./primitives.js";
import type { FileConfig } from "./file.js";
import type { WeixinConfig } from "./types.js";

/**
 * 对应 help-sale.config.yaml 的 `weixin` 段:微信 iLink 机器人通道。
 *
 * 所有键都必填(不启用就显式写 enabled: false,其余键照常给出)。凭据可以来自这里,
 * 也可以由扫码登录写入 data/weixin/account.json —— 两处都为空时只保留状态查询,不发请求。
 */
export function loadWeixinConfig(file: FileConfig): WeixinConfig {
	const w = file.weixin;
	return {
		weixinEnabled: bool(w?.enabled, "weixin.enabled"),
		weixinBaseUrl: str(w?.baseUrl, "weixin.baseUrl"),
		weixinAccountId: str(w?.accountId, "weixin.accountId"),
		weixinToken: str(w?.token, "weixin.token"),
		weixinTenantId: str(w?.tenantId, "weixin.tenantId"),
		weixinBotType: str(w?.botType, "weixin.botType"),
		weixinMaxMessageLength: num(w?.maxMessageLength, "weixin.maxMessageLength"),
		weixinSendRetries: num(w?.sendRetries, "weixin.sendRetries"),
		weixinSendRetryDelayMs: num(w?.sendRetryDelayMs, "weixin.sendRetryDelayMs"),
		weixinPollTimeoutMs: num(w?.pollTimeoutMs, "weixin.pollTimeoutMs"),
		weixinDedupTtlSeconds: num(w?.dedupTtlSeconds, "weixin.dedupTtlSeconds"),
		weixinAgentTimeoutMs: num(w?.agentTimeoutMs, "weixin.agentTimeoutMs"),
		weixinAutoReply: bool(w?.autoReply, "weixin.autoReply"),
		weixinAckText: str(w?.ackText, "weixin.ackText"),
		weixinUnsupportedText: str(w?.unsupportedText, "weixin.unsupportedText"),
		weixinAllowFrom: strList(w?.allowFrom, "weixin.allowFrom"),
	};
}