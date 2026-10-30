/** 微信 iLink 机器人通道的公共类型。 */

/** 扫码登录得到的账号凭据(落盘在 data/weixin/account.json)。 */
export interface WeixinAccount {
	accountId: string;
	token: string;
	baseUrl: string;
	userId: string;
	savedAt: string;
}

/** iLink 消息里的一个 item(文本/图片/语音/文件/视频)。 */
export interface WeixinItem {
	type?: number;
	text_item?: { text?: string };
	[key: string]: unknown;
}

/** iLink getupdates 推过来的一条消息。 */
export interface WeixinInbound {
	messageId: string;
	fromUserId: string;
	toUserId: string;
	roomId: string;
	msgType: number;
	items: WeixinItem[];
	contextToken: string;
	raw: Record<string, unknown>;
}

/** 出站结果:分片数、失败原因。 */
export interface WeixinSendResult {
	ok: boolean;
	chunks: number;
	error?: string;
}

export const ITEM_TEXT = 1;
export const ITEM_IMAGE = 2;
export const ITEM_VOICE = 3;
export const ITEM_FILE = 4;
export const ITEM_VIDEO = 5;

export const MSG_TYPE_USER = 1;
export const MSG_TYPE_BOT = 2;
export const MSG_STATE_FINISH = 2;