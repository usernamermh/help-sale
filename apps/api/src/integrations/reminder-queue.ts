import { Redis } from "ioredis";

export interface ReminderQueue {
	add(taskId: string, dueAtMs: number | null): Promise<void>;
	remove(taskId: string): Promise<void>;
	due(nowMs: number, limit?: number): Promise<string[]>;
	close(): Promise<void>;
}

export interface RedisConfig {
	enabled: boolean;
	host: string;
	port: number;
	password?: string;
}

const KEY = "rmh:tasks:due";

/** Redis ZSET 到期队列:失败时静默降级,不影响主流程。 */
export function createReminderQueue(config: RedisConfig): ReminderQueue {
	if (!config.enabled) return createMemoryReminderQueue();

	let client: Redis | undefined = new Redis({
		host: config.host,
		port: config.port,
		password: config.password || undefined,
		retryStrategy: () => null, // 不自动重连(降级优先)
		connectTimeout: 4000,
		maxRetriesPerRequest: 1,
		enableOfflineQueue: false,
	});
	client.on("error", (error: Error) => {
		console.warn(`[redis] 提醒队列不可用: ${error.message}`);
	});

	const op = async (fn: () => Promise<unknown>): Promise<void> => {
		if (!client) return;
		try {
			await fn();
		} catch {
			// 降级:忽略
		}
	};

	return {
		async add(taskId, dueAtMs) {
			if (dueAtMs == null || !Number.isFinite(dueAtMs)) return;
			await op(async () => {
				await client!.zadd(KEY, dueAtMs, taskId);
			});
		},
		async remove(taskId) {
			await op(async () => {
				await client!.zrem(KEY, taskId);
			});
		},
		async due(nowMs, limit = 100) {
			if (!client) return [];
			try {
				return (await client.zrangebyscore(KEY, 0, nowMs, "LIMIT", 0, limit)) as string[];
			} catch {
				return [];
			}
		},
		async close() {
			if (client) {
				try {
					await client.quit();
				} catch {
					client.disconnect();
				}
				client = undefined;
			}
		},
	};
}

/** 内存实现:测试与禁用时使用。 */
export function createMemoryReminderQueue(): ReminderQueue {
	const map = new Map<string, number>();
	return {
		async add(taskId, dueAtMs) {
			if (dueAtMs != null && Number.isFinite(dueAtMs)) map.set(taskId, dueAtMs);
		},
		async remove(taskId) {
			map.delete(taskId);
		},
		async due(nowMs, limit = 100) {
			return [...map.entries()]
				.filter(([, due]) => due <= nowMs)
				.sort((a, b) => a[1] - b[1])
				.slice(0, limit)
				.map(([id]) => id);
		},
		async close() {
			map.clear();
		},
	};
}