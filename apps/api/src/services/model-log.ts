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
	request?: string;
	response?: string;
	status?: number;
	durationMs?: number;
	error?: string;
}

export interface ModelLogConfig {
	enabled: boolean;
	dir: string;
	maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

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
export function appendModelCallLog(dir: string, entry: Omit<ModelCallLogEntry, "ts">, maxBytes = DEFAULT_MAX_BYTES): void {
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
export function wrapFetchWithModelLog(
	fetchImpl: typeof fetch,
	cfg: ModelLogConfig,
	meta: { modelId?: string },
): typeof fetch {
	if (!cfg.enabled) return fetchImpl;
	const maxBytes = cfg.maxBytes ?? DEFAULT_MAX_BYTES;
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
					request: bodyText,
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
				appendModelCallLog(cfg.dir, {
					event: "response",
					requestId,
					modelId,
					request: bodyText,
					response: text,
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