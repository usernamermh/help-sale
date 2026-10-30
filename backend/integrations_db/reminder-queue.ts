import { Redis } from "ioredis";
import { config } from "../env.js";

/** 队列里的条目:租户 + 任务,租户维度进成员名,避免跨租户误删/误读。 */
export interface ReminderEntry {
	tenantId: string;
	taskId: string;
}

export interface ReminderQueue {
	add(tenantId: string, taskId: string, dueAtMs: number | null): Promise<void>;
	remove(tenantId: string, taskId: string): Promise<void>;
	due(nowMs: number, limit?: number): Promise<ReminderEntry[]>;
	close(): Promise<void>;
}

const MEMBER_SEP = "::";
const member = (tenantId: string, taskId: string) => `${tenantId}${MEMBER_SEP}${taskId}`;
/** 兼容历史成员(没有租户前缀):租户留空,由调用方按自己租户过滤时自然丢弃。 */
function parseMember(value: string): ReminderEntry {
	const index = value.indexOf(MEMBER_SEP);
	if (index < 0) return { tenantId: "", taskId: value };
	return { tenantId: value.slice(0, index), taskId: value.slice(index + MEMBER_SEP.length) };
}

export interface RedisConfig {
	enabled: boolean;
	host: string;
	port: number;
	password?: string;
}

const KEY = `${config.userKey}:tasks:due`;

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
		async add(tenantId, taskId, dueAtMs) {
			if (dueAtMs == null || !Number.isFinite(dueAtMs)) return;
			await op(async () => {
				await client!.zadd(KEY, dueAtMs, member(tenantId, taskId));
			});
		},
		async remove(tenantId, taskId) {
			await op(async () => {
				await client!.zrem(KEY, member(tenantId, taskId));
			});
		},
		async due(nowMs, limit = 100) {
			if (!client) return [];
			try {
				const raw = (await client.zrangebyscore(KEY, 0, nowMs, "LIMIT", 0, limit)) as string[];
				return raw.map(parseMember);
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
		async add(tenantId, taskId, dueAtMs) {
			if (dueAtMs != null && Number.isFinite(dueAtMs)) map.set(member(tenantId, taskId), dueAtMs);
		},
		async remove(tenantId, taskId) {
			map.delete(member(tenantId, taskId));
		},
		async due(nowMs, limit = 100) {
			return [...map.entries()]
				.filter(([, due]) => due <= nowMs)
				.sort((a, b) => a[1] - b[1])
				.slice(0, limit)
				.map(([key]) => parseMember(key));
		},
		async close() {
			map.clear();
		},
	};
}