/**
 * 会话事件的进程内广播:外部渠道(微信)写入消息或改标题时推给网页端,
 * 让手机上发的消息在网页里同步出现。
 *
 * 只在单进程内有效(本项目就是单进程);多实例部署需要换成 Redis 之类的总线。
 */

export interface ThreadEvent {
	type: "message" | "title";
	tenantId: string;
	threadId: string;
	role?: "user" | "assistant";
	text?: string;
	seq?: number;
	title?: string;
	at: number;
}

type Listener = (event: ThreadEvent) => void;

const listeners = new Set<Listener>();

export function publishThreadEvent(event: Omit<ThreadEvent, "at">): void {
	const payload: ThreadEvent = { ...event, at: Date.now() };
	for (const listener of listeners) {
		try {
			listener(payload);
		} catch {
			// 单个订阅者出错不影响其他订阅者与调用方
		}
	}
}

export function subscribeThreadEvents(listener: Listener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** 测试用:清空订阅者。 */
export function resetThreadEventListeners(): void {
	listeners.clear();
}