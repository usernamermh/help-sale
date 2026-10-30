/**
 * 子代理任务的唤醒信号。
 *
 * 消费者原本是"每 2 秒扫一遍看板"的常驻轮询 —— 但绝大多数时候根本没有多代理任务,
 * 空闲也在空转(每次扫一遍数据库,而库在网络上)。这里改成事件驱动:
 *   · 有卡进入 pending(新建 / 被改回 pending)→ notifySubagentWork() 立刻唤醒消费者;
 *   · 消费者只在"确实有待执行的卡"时循环扫描,没活就退出,不做任何定时轮询;
 *   · 可选的"低频兜底扫描"(subagents.idleSweepIntervalMs)只用于跨进程/崩溃恢复,
 *     设为 0 即完全事件驱动。
 */
type Worker = () => void;

let worker: Worker | undefined;

/** 消费者注册自己(进程内单例)。 */
export function registerSubagentWorker(fn: Worker): void {
	worker = fn;
}

export function unregisterSubagentWorker(): void {
	worker = undefined;
}

/**
 * 跨实例广播钩子:Redis 可用时由宿主注入,把"有活了"发到频道上,让别的实例也立刻检查一次
 * (多实例下卡可能由任意实例消费,越早知道越好)。Redis 不可用时保持空,只做进程内唤醒。
 */
let wakePublisher: ((message: string) => void) | undefined;

export function setSubagentWakePublisher(fn: ((message: string) => void) | undefined): void {
	wakePublisher = fn;
}

/** 生产者调用:有新的待执行任务了。没有消费者在跑时静默忽略。 */
export function notifySubagentWork(): void {
	worker?.();
	wakePublisher?.("wake");
}

export function hasSubagentWorker(): boolean {
	return Boolean(worker);
}