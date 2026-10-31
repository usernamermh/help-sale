/**
 * 每租户限流与并发配额。
 *
 * 目标:让**单个租户的问题不拖垮全体** —— 一个租户刷请求、开几十个会话同时跑 agent,
 * 都只能吃满"属于它自己"的那份额度,超出的请求立刻被拒(429 / 排队提示),不占用共享资源。
 *
 * 两种后端:
 *   · Redis 可用 → 跨实例共享额度(多实例部署下仍是"每租户一份",不会被实例数放大);
 *   · Redis 不可用 → 进程内计数(单实例部署,额度仍然按租户隔离)。
 *
 * 两类额度:
 *   ① 请求速率:令牌桶(每分钟 requestPerMinute,桶容量 requestBurst);
 *   ② agent 并发:同时在跑的轮次上限(agentConcurrency),用完即拒,跑完释放。
 */
import { Redis } from "ioredis";

export interface TenantQuotaConfig {
	enabled: boolean;
	/** 每租户每分钟请求上限 */
	requestPerMinute: number;
	/** 令牌桶突发容量 */
	requestBurst: number;
	/** 每租户同时在跑的 agent 轮次上限 */
	agentConcurrency: number;
	/** 被限流时建议客户端等待的秒数 */
	retryAfterSeconds: number;
	redis?: { enabled: boolean; host: string; port: number; password?: string };
	now?: () => number;
}

export interface QuotaDecision {
	allowed: boolean;
	/** 被拒时建议等待的毫秒数 */
	retryAfterMs: number;
	/** 剩余额度(令牌数 / 剩余并发槽),便于排查与响应头 */
	remaining: number;
}

export interface TenantQuota {
	readonly backend: "redis" | "memory" | "disabled";
	tryAcquireRequest(tenantId: string): Promise<QuotaDecision>;
	tryAcquireAgentRun(tenantId: string): Promise<QuotaDecision>;
	releaseAgentRun(tenantId: string): Promise<void>;
	/** 只读快照:当前占用的 agent 槽位(排查用) */
	inspect(tenantId: string): Promise<{ agentRuns: number }>;
	close(): Promise<void>;
}

const REQ_PREFIX = "rmh:quota:req:";
const AGENT_PREFIX = "rmh:quota:agent:";

/** 令牌桶(Redis,Lua 原子):按时间补充令牌,取不到就拒。 */
const TOKEN_BUCKET_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local ratePerMs = tonumber(ARGV[2])
local nowMs = tonumber(ARGV[3])
local ttlMs = tonumber(ARGV[4])
local data = redis.call('hmget', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then tokens = capacity; ts = nowMs end
local delta = math.max(0, nowMs - ts)
tokens = math.min(capacity, tokens + delta * ratePerMs)
local allowed = 0
if tokens >= 1 then tokens = tokens - 1; allowed = 1 end
redis.call('hmset', key, 'tokens', tokens, 'ts', nowMs)
redis.call('pexpire', key, ttlMs)
return { allowed, math.floor(tokens) }
`;

/** 并发槽位:自增后越界就回滚(Lua 原子),避免"抢了又退"造成抖动。 */
const ACQUIRE_SLOT_SCRIPT = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local ttlMs = tonumber(ARGV[2])
local current = tonumber(redis.call('get', key) or '0')
if current >= limit then
  redis.call('pexpire', key, ttlMs)
  return { 0, limit - current }
end
current = redis.call('incr', key)
redis.call('pexpire', key, ttlMs)
return { 1, limit - current }
`;

const RELEASE_SLOT_SCRIPT = `
local key = KEYS[1]
local current = tonumber(redis.call('get', key) or '0')
if current <= 0 then return 0 end
return redis.call('decr', key)
`;

const SLOT_TTL_MS = 60 * 60 * 1000; // 兜底:进程崩溃没释放时,1 小时后自动回收

interface BucketState {
	tokens: number;
	updatedAt: number;
}

export function createTenantQuota(config: TenantQuotaConfig): TenantQuota {
	const now = config.now ?? Date.now;
	const retryAfterMs = Math.max(1000, config.retryAfterSeconds * 1000);

	if (!config.enabled) {
		return {
			backend: "disabled",
			async tryAcquireRequest() {
				return { allowed: true, retryAfterMs: 0, remaining: Number.MAX_SAFE_INTEGER };
			},
			async tryAcquireAgentRun() {
				return { allowed: true, retryAfterMs: 0, remaining: Number.MAX_SAFE_INTEGER };
			},
			async releaseAgentRun() {
				/* 未启用:无需释放 */
			},
			async inspect() {
				return { agentRuns: 0 };
			},
			async close() {
				/* 未启用:无需关闭 */
			},
		};
	}

	// ── 进程内实现(SQLite/单实例部署,或 Redis 不可用时) ──
	const buckets = new Map<string, BucketState>();
	const slots = new Map<string, number>();

	const memoryAcquire = (tenantId: string): QuotaDecision => {
		const stamp = now();
		const ratePerMs = config.requestPerMinute / 60000;
		const state = buckets.get(tenantId) ?? { tokens: config.requestBurst, updatedAt: stamp };
		const elapsed = Math.max(0, stamp - state.updatedAt);
		state.tokens = Math.min(config.requestBurst, state.tokens + elapsed * ratePerMs);
		state.updatedAt = stamp;
		if (state.tokens >= 1) {
			state.tokens -= 1;
			buckets.set(tenantId, state);
			return { allowed: true, retryAfterMs: 0, remaining: Math.floor(state.tokens) };
		}
		buckets.set(tenantId, state);
		const deficit = 1 - state.tokens;
		return { allowed: false, retryAfterMs: Math.max(retryAfterMs, Math.ceil(deficit / ratePerMs)), remaining: 0 };
	};

	const memoryQuota: TenantQuota = {
		backend: "memory",
		async tryAcquireRequest(tenantId) {
			return memoryAcquire(tenantId);
		},
		async tryAcquireAgentRun(tenantId) {
			const current = slots.get(tenantId) ?? 0;
			if (current >= config.agentConcurrency) {
				return { allowed: false, retryAfterMs, remaining: 0 };
			}
			slots.set(tenantId, current + 1);
			return { allowed: true, retryAfterMs: 0, remaining: config.agentConcurrency - current - 1 };
		},
		async releaseAgentRun(tenantId) {
			const current = slots.get(tenantId) ?? 0;
			if (current <= 1) slots.delete(tenantId);
			else slots.set(tenantId, current - 1);
		},
		async inspect(tenantId) {
			return { agentRuns: slots.get(tenantId) ?? 0 };
		},
		async close() {
			buckets.clear();
			slots.clear();
		},
	};

	if (!config.redis?.enabled) return memoryQuota;

	// ── Redis 实现(多实例共享额度) ──
	let client: Redis | undefined;
	let degraded = false;
	try {
		client = new Redis({
			host: config.redis.host,
			port: config.redis.port,
			password: config.redis.password || undefined,
			// 额度最好自愈:抖动后自动重连
			retryStrategy: (times: number) => Math.min(times * 300, 3000),
			connectTimeout: 4000,
			maxRetriesPerRequest: 1,
		});
		client.on("error", (error: Error) => {
			if (!degraded) {
				degraded = true;
				console.warn(`[quota] Redis 不可用,额度降级为进程内计数: ${error.message}`);
			}
		});
	} catch {
		return memoryQuota;
	}

	const redisQuota: TenantQuota = {
		backend: "redis",
		async tryAcquireRequest(tenantId) {
			try {
				const result = (await client!.eval(
					TOKEN_BUCKET_SCRIPT,
					1,
					`${REQ_PREFIX}${tenantId}`,
					String(config.requestBurst),
					String(config.requestPerMinute / 60000),
					String(now()),
					String(SLOT_TTL_MS),
				)) as [number, number];
				const allowed = Number(result?.[0] ?? 0) === 1;
				return { allowed, retryAfterMs: allowed ? 0 : retryAfterMs, remaining: Number(result?.[1] ?? 0) };
			} catch {
				degraded = true;
				return memoryAcquire(tenantId);
			}
		},
		async tryAcquireAgentRun(tenantId) {
			try {
				const result = (await client!.eval(
					ACQUIRE_SLOT_SCRIPT,
					1,
					`${AGENT_PREFIX}${tenantId}`,
					String(config.agentConcurrency),
					String(SLOT_TTL_MS),
				)) as [number, number];
				const allowed = Number(result?.[0] ?? 0) === 1;
				return { allowed, retryAfterMs: allowed ? 0 : retryAfterMs, remaining: Math.max(0, Number(result?.[1] ?? 0)) };
			} catch {
				degraded = true;
				return memoryQuota.tryAcquireAgentRun(tenantId);
			}
		},
		async releaseAgentRun(tenantId) {
			try {
				await client!.eval(RELEASE_SLOT_SCRIPT, 1, `${AGENT_PREFIX}${tenantId}`);
			} catch {
				await memoryQuota.releaseAgentRun(tenantId);
			}
		},
		async inspect(tenantId) {
			try {
				const value = await client!.get(`${AGENT_PREFIX}${tenantId}`);
				return { agentRuns: Number(value ?? 0) };
			} catch {
				return memoryQuota.inspect(tenantId);
			}
		},
		async close() {
			if (!client) return;
			try {
				await client.quit();
			} catch {
				client.disconnect();
			}
			client = undefined;
		},
	};
	return redisQuota;
}