import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** 模型输入输出日志文件名(位于 logging.dir 下)。 */
export const MODEL_LOG_FILE = "model-calls.log";

export interface ModelCallLogEntry {
	ts: string;
	/** request:请求发出时立即落盘(仅记请求 ID);response:响应体读完后补写完整请求/返回;error:调用失败 */
	event?: "request" | "response" | "error";
	/** 一次模型调用唯一 ID,request/response/error 三行通过它关联 */
	requestId?: string;
	modelId?: string;
	/** 完整请求/响应,直接落对象(可由 JSON 解析时);无法解析时保留原文本 */
	request?: unknown;
	response?: unknown;
	status?: number;
	durationMs?: number;
	error?: string;
}

export interface ModelLogConfig {
	enabled: boolean;
	dir: string;
	/** 轮转上限(字节),必填:由 help-sale.config.yaml logging.maxBytes 提供 */
	maxBytes: number;
}

function rotateIfNeeded(file: string, maxBytes: number): void {
	try {
		if (Buffer.byteLength(readFileSync(file, "utf8")) > maxBytes) {
			const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
			writeFileSync(file, lines.slice(Math.floor(lines.length / 2)).join("\n") + "\n", "utf8");
		}
	} catch {
		// 轮转失败不影响调用方
	}
}

/** 追加一条模型调用日志(NDJSON),自动创建目录并在超过上限时保留最近一半。 */
export function appendModelCallLog(dir: string, entry: Omit<ModelCallLogEntry, "ts">, maxBytes: number): void {
	try {
		mkdirSync(dir, { recursive: true });
		const file = path.join(dir, MODEL_LOG_FILE);
		const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
		appendFileSync(file, line + "\n", "utf8");
		rotateIfNeeded(file, maxBytes);
	} catch {
		// 落盘失败不影响业务(仅本地日志)
	}
}

export function readModelCallLogs(dir: string): ModelCallLogEntry[] {
	const file = path.join(dir, MODEL_LOG_FILE);
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line) as ModelCallLogEntry;
			} catch {
				return null;
			}
		})
		.filter((x): x is ModelCallLogEntry => x !== null);
}

/**
 * 包装 fetch:启用时把请求体与响应体(原始文本)异步写入本地日志;未启用时原样透传。
 * 响应通过 clone 读取,不影响上游消费;读取失败时记录 error 字段。
 */

/**
 * 把 SSE 流式响应聚合为最终输入输出(与日志里只记最终结果、不记流式 chunk 对应)。
 * 解析 `data: {...}` 块,合并 content/reasoning_content/tool_calls(按 index 拼接 arguments),
 * 记录 finish_reason 与 usage;非 SSE 文本原样返回。
 */

/** 请求/响应体按 JSON 落对象;解析失败保留原文本。 */
function asJsonObject(text: string): unknown {
	try {
		const parsed = JSON.parse(text) as unknown;
		return parsed !== null && typeof parsed === "object" ? parsed : text;
	} catch {
		return text;
	}
}
export function aggregateSseResponse(raw: string): unknown {
	const text = raw.trim();
	if (!text.includes("data:")) return raw;
	let content = "";
	let reasoning = "";
	const toolCalls: Array<{ id?: string; name?: string; arguments?: string }> = [];
	let finishReason: string | null = null;
	let usage: unknown;
	let chunkCount = 0;
	let parsedAny = false;
	for (const line of text.split(/\r?\n/)) {
		const t = line.trim();
		if (!t.startsWith("data:")) continue;
		const payload = t.slice(5).trim();
		if (!payload || payload === "[DONE]") continue;
		let chunk: { choices?: Array<{ delta?: { content?: string; reasoning_content?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string | null }>; usage?: unknown };
		try {
			chunk = JSON.parse(payload) as typeof chunk;
		} catch {
			continue;
		}
		parsedAny = true;
		chunkCount++;
		const delta = chunk.choices?.[0]?.delta;
		if (delta) {
			if (typeof delta.content === "string") content += delta.content;
			if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
			if (Array.isArray(delta.tool_calls)) {
				for (const tc of delta.tool_calls) {
					const idx = tc.index ?? toolCalls.length;
					toolCalls[idx] ??= { id: "", name: "", arguments: "" };
					if (tc.id) toolCalls[idx].id = tc.id;
					if (tc.function?.name) toolCalls[idx].name = tc.function.name;
					if (typeof tc.function?.arguments === "string") toolCalls[idx].arguments += tc.function.arguments;
				}
			}
		}
		if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
		if (chunk.usage !== undefined) usage = chunk.usage;
	}
	if (!parsedAny) return raw;
	const out: Record<string, unknown> = { streamed: true, chunkCount, usage };
	if (content) out.content = content;
	if (reasoning) out.reasoning = reasoning;
	const calls = toolCalls.filter((tc) => tc && (tc.id || tc.name || tc.arguments));
	if (calls.length) out.toolCalls = calls;
	if (finishReason) out.finishReason = finishReason;
	// 聚合失败兜底:保留原始文本
	if (!content && !reasoning && !calls.length) return raw;
	return out;
}
export function wrapFetchWithModelLog(
	fetchImpl: typeof fetch,
	cfg: ModelLogConfig,
	meta: { modelId?: string },
): typeof fetch {
	if (!cfg.enabled) return fetchImpl;
	const maxBytes = cfg.maxBytes;
	return async (input, init) => {
		const bodyText = typeof init?.body === "string" ? init.body : null;
		const modelId = meta.modelId;
		const requestId = randomUUID();
		const started = Date.now();
		// 请求发出前先同步落一行(只记请求 ID,不落完整请求体),避免执行进程提前退出时完全丢失条目
		if (bodyText != null) {
			appendModelCallLog(cfg.dir, { event: "request", requestId, modelId }, maxBytes);
		}
		let res: Response;
		try {
			res = await fetchImpl(input, init);
		} catch (error) {
			if (bodyText != null) {
				appendModelCallLog(cfg.dir, {
					event: "error",
					requestId,
					modelId,
					request: asJsonObject(bodyText),
					error: error instanceof Error ? error.message : String(error),
					durationMs: Date.now() - started,
				}, maxBytes);
			}
			throw error;
		}
		if (bodyText == null) return res;
		const clone = res.clone();
		// 响应体读完后再异步补一行(带同一请求 ID 的完整请求 + 返回 + 状态与耗时);通过 clone 读取,不影响上游消费
		void (async () => {
			try {
				const text = await clone.text();
				// 只记最终输入输出:SSE 流聚合为内容/推理/工具调用/用量,不记流式 chunk 原文
				const finalResponse = aggregateSseResponse(text);
				appendModelCallLog(cfg.dir, {
					event: "response",
					requestId,
					modelId,
					request: asJsonObject(bodyText),
					response: typeof finalResponse === "string" ? asJsonObject(finalResponse) : finalResponse,
					status: res.status,
					durationMs: Date.now() - started,
				}, maxBytes);
			} catch (error) {
				appendModelCallLog(cfg.dir, {
					event: "error",
					requestId,
					modelId,
					request: bodyText,
					error: error instanceof Error ? error.message : String(error),
					status: res.status,
					durationMs: Date.now() - started,
				}, maxBytes);
			}
		})();
		return res;
	};
}