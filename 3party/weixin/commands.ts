import type { DatabaseSync } from "node:sqlite";
import { createThread, deleteThread, listThreadMessages, setThreadTitle } from "../../backend/integrations_pi/tables/agents/threads.js";
import { ensureThreadSummary } from "../../backend/services/context-compress.js";
import { setStopSignal } from "../../backend/services/stop-signal.js";
import { bindWeixinUser, ensureWeixinUser, listWeixinThreads, setWeixinThread, upsertWeixinThread } from "./tables.js";
import { maskId } from "./text.js";

/**
 * 微信里的会话命令:在手机上管理会话,不必打开网页。
 * 命令在入队前处理,所以即使上一条消息的 agent 还在跑,`/stop` 也能立刻生效。
 */

export interface WeixinCommandContext {
	db: DatabaseSync;
	tenantId: string;
	openid: string;
	/** /sessions 最多列几条 */
	sessionsLimit: number;
	/** 通道状态(可选,供 /status 展示) */
	status?: () => Record<string, unknown>;
}

export interface ParsedCommand {
	name: string;
	args: string;
}

const COMMAND_ALIASES: Record<string, string> = {
	"帮助": "help",
	"?": "help",
	"新会话": "new",
	"新建": "new",
	"会话": "sessions",
	"列表": "sessions",
	"切换": "switch",
	"压缩": "compact",
	"清空": "clear",
	"停止": "stop",
	"状态": "status",
	"我是谁": "whoami",
	"绑定": "bind",
};

export function parseCommand(text: string): ParsedCommand | undefined {
	const match = /^\/([^\s/]+)\s*([\s\S]*)$/.exec(String(text ?? "").trim());
	if (!match) return undefined;
	const raw = match[1].toLowerCase();
	return { name: COMMAND_ALIASES[raw] ?? raw, args: match[2].trim() };
}

export function commandHelp(): string {
	return [
		"可用命令：",
		"/help —— 命令清单",
		"/new —— 开一个新会话（之后的消息记到新会话）",
		"/sessions —— 列出本联系人的历史会话",
		"/switch <序号|会话ID> —— 切到指定会话",
		"/compact —— 压缩当前会话上下文（长对话用）",
		"/clear —— 清空当前会话并重新开始",
		"/stop —— 中止正在执行的那一轮",
		"/status —— 通道状态与当前会话信息",
		"/whoami —— 看当前绑定身份",
		"/bind <sales|customers>:<编号> —— 绑定销售或客户",
		"",
		"不带 / 的消息照常交给 agent 处理。",
	].join("\n");
}

function currentThreadId(ctx: WeixinCommandContext): string | undefined {
	const user = ensureWeixinUser(ctx.db, ctx.tenantId, ctx.openid);
	return user.threadId ?? undefined;
}

function ensureThread(ctx: WeixinCommandContext): string {
	const existing = currentThreadId(ctx);
	if (existing) {
		upsertWeixinThread(ctx.db, ctx.tenantId, ctx.openid, existing);
		return existing;
	}
	const thread = createThread(ctx.db, ctx.tenantId);
	setWeixinThread(ctx.db, ctx.tenantId, ctx.openid, thread.id);
	upsertWeixinThread(ctx.db, ctx.tenantId, ctx.openid, thread.id, "新会话");
	return thread.id;
}

/** 返回 undefined 表示这不是命令,调用方按普通消息处理。 */
export async function runWeixinCommand(ctx: WeixinCommandContext, text: string): Promise<string | undefined> {
	const parsed = parseCommand(text);
	if (!parsed) return undefined;
	// 任何命令都先把联系人建档,后续 setWeixinThread / bind 才有行可更新
	ensureWeixinUser(ctx.db, ctx.tenantId, ctx.openid);

	switch (parsed.name) {
		case "help":
		case "start":
			return commandHelp();

		case "new": {
			const thread = createThread(ctx.db, ctx.tenantId);
			setWeixinThread(ctx.db, ctx.tenantId, ctx.openid, thread.id);
			upsertWeixinThread(ctx.db, ctx.tenantId, ctx.openid, thread.id, "新会话");
			return "已新建会话，之后的消息会记到这个会话里。发 /sessions 可以回看历史会话。";
		}

		case "sessions": {
			upsertWeixinThread(ctx.db, ctx.tenantId, ctx.openid, currentThreadId(ctx) ?? "");
			const rows = listWeixinThreads(ctx.db, ctx.tenantId, ctx.openid, ctx.sessionsLimit).filter((row) => row.threadId);
			if (rows.length === 0) return "还没有历史会话。直接发消息就会自动建一个。";
			const active = currentThreadId(ctx);
			const lines = rows.map((row, index) => {
				const mark = row.threadId === active ? "← 当前" : "";
				const title = row.title || "未命名会话";
				return `${index + 1}. ${title}（${maskId(row.threadId, 8, 4)}）${mark}`;
			});
			return ["本联系人的会话：", ...lines, "", "用 /switch <序号> 切换。"].join("\n");
		}

		case "switch":
		case "s": {
			const target = parsed.args.trim();
			if (!target) return "用法：/switch <序号|会话ID>，序号来自 /sessions。";
			const rows = listWeixinThreads(ctx.db, ctx.tenantId, ctx.openid, ctx.sessionsLimit);
			let threadId = "";
			if (/^\d+$/.test(target)) {
				const index = Number(target) - 1;
				threadId = rows[index]?.threadId ?? "";
			} else {
				threadId = rows.find((row) => row.threadId === target || row.threadId.startsWith(target))?.threadId ?? "";
			}
			if (!threadId) return "没找到这个会话，先发 /sessions 看列表。";
			setWeixinThread(ctx.db, ctx.tenantId, ctx.openid, threadId);
			upsertWeixinThread(ctx.db, ctx.tenantId, ctx.openid, threadId);
			const messages = listThreadMessages(ctx.db, ctx.tenantId, threadId);
			return `已切到会话 ${maskId(threadId, 8, 4)}（${messages.length} 条消息），之后的消息都会记到这里。`;
		}

		case "compact":
		case "compress": {
			const threadId = ensureThread(ctx);
			const summary = ensureThreadSummary(ctx.db, ctx.tenantId, threadId);
			return `当前会话已压缩，摘要 ${summary.length} 字，之后的对话会带上这段摘要继续。`;
		}

		case "clear": {
			const threadId = currentThreadId(ctx);
			if (threadId) deleteThread(ctx.db, ctx.tenantId, threadId);
			const thread = createThread(ctx.db, ctx.tenantId);
			setWeixinThread(ctx.db, ctx.tenantId, ctx.openid, thread.id);
			upsertWeixinThread(ctx.db, ctx.tenantId, ctx.openid, thread.id, "新会话");
			return "当前会话已清空，从这条之后重新开始。";
		}

		case "stop": {
			const threadId = currentThreadId(ctx);
			if (!threadId) return "当前没有正在执行的会话。";
			await setStopSignal(threadId);
			return "已请求中止当前这一轮，稍等它收尾。";
		}

		case "status": {
			const threadId = currentThreadId(ctx);
			const messages = threadId ? listThreadMessages(ctx.db, ctx.tenantId, threadId) : [];
			const status = ctx.status?.() ?? {};
			const loggedIn = status.loggedIn ? "已登录" : "未登录";
			return [
				`通道：${loggedIn}，轮询：${status.polling ? "进行中" : "未开始"}`,
				`租户：${ctx.tenantId}`,
				`当前会话：${threadId ? maskId(threadId, 8, 4) : "尚未创建"}，共 ${messages.length} 条消息`,
				status.lastError ? `最近错误：${String(status.lastError)}` : "",
			].filter(Boolean).join("\n");
		}

		case "whoami": {
			const user = ensureWeixinUser(ctx.db, ctx.tenantId, ctx.openid);
			const bound = user.boundId ? `${user.boundKind}：${user.boundId}` : "尚未绑定";
			return `微信标识：${maskId(ctx.openid, 8, 4)}\n租户：${ctx.tenantId}\n绑定身份：${bound}`;
		}

		case "bind": {
			const match = /^(sales|customers)\s*[:：]\s*(\S+)$/.exec(parsed.args);
			if (!match) return "用法：/bind sales:S01 或 /bind customers:cust-001。";
			ensureWeixinUser(ctx.db, ctx.tenantId, ctx.openid);
			const ok = bindWeixinUser(ctx.db, ctx.tenantId, ctx.openid, match[1], match[2]);
			return ok ? `已绑定 ${match[1]}：${match[2]}。` : "绑定失败，请稍后再试。";
		}

		case "title": {
			const threadId = ensureThread(ctx);
			const title = parsed.args.trim();
			if (!title) return "用法：/title 新的会话标题。";
			setThreadTitle(ctx.db, ctx.tenantId, threadId, title);
			upsertWeixinThread(ctx.db, ctx.tenantId, ctx.openid, threadId, title);
			return `会话标题已改为「${title}」。`;
		}

		default:
			return `没有这个命令：/${parsed.name}\n\n${commandHelp()}`;
	}
}