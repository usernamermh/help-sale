/**
 * 多实例协调层。
 *
 * 设计取舍(与部署约定一致):
 *   · Redis 可用 → 支持多实例:后台"单例语义"的任务(定时任务、微信长轮询)用主实例锁选主;
 *     子任务卡走上"竞争消费 + 原子领取",并由 Redis 频道做跨实例唤醒(建卡的实例立刻通知所有实例)。
 *   · Redis 不可用 → 退化为进程内模式:所有后台任务都在本进程跑,**只支持单实例部署**
 *     (启动日志会明确提示这一点)。
 *
 * 主实例锁语义:key 的持有者才是主;续租失败(别人抢走了)会立刻回调 false,让本实例停掉单例任务。
 * Redis 抖动时不主动放弃领导权(优先保证可用性),只在确认锁已易主时才让位。
 */
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { Redis } from "ioredis";

export interface ClusterConfig {
	enabled: boolean;
	host: string;
	port: number;
	password?: string;
	/** 主实例锁租约(毫秒);续租频率取其 1/3 */
	leaderLeaseMs: number;
}

export interface ClusterCoordinator {
	/** Redis 是否可用(决定是否支持多实例) */
	readonly redisEnabled: boolean;
	/** 本实例标识:写进看板卡,便于排查"这张卡是谁在跑" */
	readonly instanceId: string;
	/** 监听/取消监听某个主实例锁;无 Redis 时立刻回调 true */
	watchLeadership(key: string, onChange: (isLeader: boolean) => void): () => void;
	/** 当前是否持有该锁(单例任务在循环里自查);无 Redis 时恒为 true */
	isLeader(key: string): boolean;
	/** 跨实例广播(无 Redis 时为空操作:本进程内的唤醒由 subagent-signal 负责) */
	publish(channel: string, message: string): void;
	/** 订阅跨实例广播,返回取消函数 */
	subscribe(channel: string, onMessage: (message: string) => void): () => void;
	close(): Promise<void>;
}

const LEADER_PREFIX = "rmh:cluster:leader:";

/** 续租脚本:持有者续期,否则尝试抢占(NX)。返回 1=持有。 */
const RENEW_SCRIPT = `
local v = redis.call('get', KEYS[1])
if v == ARGV[1] then redis.call('pexpire', KEYS[1], ARGV[2]); return 1 end
if v == false then
  local ok = redis.call('set', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2])
  if ok then return 1 end
end
return 0
`;

export function createClusterCoordinator(config: ClusterConfig): ClusterCoordinator {
	const instanceId = `${hostname()}-${process.pid}-${randomBytes(3).toString("hex")}`;
	const leases = new Map<string, { isLeader: boolean; timer?: NodeJS.Timeout; stopped?: boolean }>();
	const listeners = new Set<(isLeader: boolean) => void>();
	if (!config.enabled) {
		return {
			redisEnabled: false,
			instanceId,
			watchLeadership(_key, onChange) {
				onChange(true); // 进程内模式:本进程就是"唯一实例"
				return () => undefined;
			},
			isLeader: () => true,
			publish: () => undefined,
			subscribe: () => () => undefined,
			close: async () => undefined,
		};
	}

	let command: Redis | undefined;
	let subscriber: Redis | undefined;
	const connect = (): Redis => {
		if (!command) {
			command = new Redis({
				host: config.host,
				port: config.port,
				password: config.password || undefined,
				// 协调连接要能自愈:抖动后自动重连,否则一次闪断就永久丢锁
				retryStrategy: (times: number) => Math.min(times * 300, 3000),
				connectTimeout: 4000,
				maxRetriesPerRequest: 1,
				enableOfflineQueue: true,
			});
			command.on("error", (error: Error) => console.warn(`[cluster] redis 不可用: ${error.message}`));
		}
		return command;
	};

	const notify = (state: { isLeader: boolean }, isLeader: boolean): void => {
		if (state.isLeader === isLeader) return;
		state.isLeader = isLeader;
		for (const listener of listeners) {
			try {
				listener(isLeader);
			} catch (error) {
				console.warn(`[cluster] 领导权回调失败: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	};

	return {
		redisEnabled: true,
		instanceId,

		watchLeadership(key, onChange) {
			let state = leases.get(key);
			if (!state) {
				state = { isLeader: false };
				leases.set(key, state);
			}
			listeners.add(onChange);

			// 拿不到锁时快速重试(2s),拿到后按租约 1/3 续租;避免"启动瞬间连不上 Redis 就等 10 秒"
			const schedule = (delayMs: number): void => {
				if (state!.stopped) return;
				state!.timer = setTimeout(() => void attempt(), delayMs);
				state!.timer.unref?.();
			};
			const attempt = async (): Promise<void> => {
				let ok = false;
				try {
					ok = Number(await connect().eval(RENEW_SCRIPT, 1, `${LEADER_PREFIX}${key}`, instanceId, String(config.leaderLeaseMs))) === 1;
					notify(state!, ok);
				} catch {
					// Redis 抖动:保持当前状态(优先可用性),不主动让位
				}
				schedule(ok ? Math.max(1000, Math.floor(config.leaderLeaseMs / 3)) : 2000);
			};
			void attempt();

			return () => {
				listeners.delete(onChange);
				if (listeners.size === 0) {
					state!.stopped = true;
					if (state!.timer) clearTimeout(state!.timer);
				}
			};
		},

		isLeader(key) {
			return leases.get(key)?.isLeader ?? false;
		},

		publish(channel, message) {
			try {
				void connect().publish(channel, message).catch(() => undefined);
			} catch {
				// 忽略
			}
		},

		subscribe(channel, onMessage) {
			if (!subscriber) {
				subscriber = new Redis({
					host: config.host,
					port: config.port,
					password: config.password || undefined,
					retryStrategy: () => null,
					connectTimeout: 4000,
					maxRetriesPerRequest: 1,
					enableOfflineQueue: false,
				});
				subscriber.on("error", () => undefined);
			}
			const client = subscriber;
			const handler = (incoming: string, message: string): void => {
				if (incoming !== channel) return;
				try {
					onMessage(message);
				} catch {
					// 忽略
				}
			};
			void client.subscribe(channel).catch(() => undefined);
			client.on("message", handler);
			return () => {
				client.off("message", handler);
				void client.unsubscribe(channel).catch(() => undefined);
			};
		},

		async close() {
			for (const state of leases.values()) { state.stopped = true; if (state.timer) clearTimeout(state.timer); }
			listeners.clear();
			for (const client of [command, subscriber]) {
				if (!client) continue;
				try {
					await client.quit();
				} catch {
					client.disconnect();
				}
			}
			command = undefined;
			subscriber = undefined;
		},
	};
}