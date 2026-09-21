import { Redis } from "ioredis";

/**
 * 统一停止信号:用户提交停止后写入停止键,后续所有执行环节(LLM/工具/工作流)检测到即停止。
 * Redis 启用时用 Redis 键(跨请求共享),未启用时退化为进程内 Map。
 */
export interface StopSignalConfig {
	enabled: boolean;
	host: string;
	port: number;
	password?: string;
}

const STOP_PREFIX = "rmh:agent:stop:";

let client: Redis | undefined;
let memoryStops = new Map<string, number>(); // runId -> 过期时间戳(ms)

/** 初始化停止信号 Redis 连接(与提醒队列独立,失败降级内存)。 */
export function initStopSignal(config: StopSignalConfig): void {
	if (!config.enabled) return;
	try {
		client = new Redis({
			host: config.host,
			port: config.port,
			password: config.password || undefined,
			retryStrategy: () => null,
			connectTimeout: 4000,
			maxRetriesPerRequest: 1,
			enableOfflineQueue: false,
		});
		client.on("error", (error: Error) => console.warn(`[stop-signal] redis 不可用,降级内存: ${error.message}`));
	} catch {
		client = undefined;
	}
}

/** 写入停止键(默认 10 分钟有效,防止残留)。 */
export async function setStopSignal(runId: string, ttlMs = 600_000): Promise<void> {
	const key = STOP_PREFIX + runId;
	if (client) {
		try { await client.set(key, "1", "PX", ttlMs); return; } catch { /* 降级 */ }
	}
	memoryStops.set(runId, Date.now() + ttlMs);
}

/** 检测是否已停止。 */
export async function isStopped(runId?: string): Promise<boolean> {
	if (!runId) return false;
	const key = STOP_PREFIX + runId;
	if (client) {
		try { return (await client.exists(key)) === 1; } catch { /* 降级 */ }
	}
	const expires = memoryStops.get(runId);
	if (!expires) return false;
	if (Date.now() > expires) { memoryStops.delete(runId); return false; }
	return true;
}

/** 清除停止键(任务正常结束时调用)。 */
export async function clearStopSignal(runId?: string): Promise<void> {
	if (!runId) return;
	if (client) {
		try { await client.del(STOP_PREFIX + runId); return; } catch { /* 忽略 */ }
	}
	memoryStops.delete(runId);
}

/** 关闭连接(服务退出时调用)。 */
export function closeStopSignal(): void {
	client?.disconnect();
	client = undefined;
	memoryStops.clear();
}