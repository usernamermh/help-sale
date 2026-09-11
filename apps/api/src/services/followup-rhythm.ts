import type { DatabaseSync } from "node:sqlite";
import { createTask } from "../repositories/tasks.js";

const HOUR_MS = 60 * 60 * 1000;

/**
 * 回访节奏:试驾后 24 小时/3 天/7 天自动生成回访任务,提车(成交)后关怀回访。
 * 把"什么时候该联系谁"从销售人脑里解放出来。
 */

/** 试驾完成后生成三段式回访节奏(24h/3d/7d),返回创建的任务 action 列表。 */
export function scheduleTestDriveFollowups(
	db: DatabaseSync,
	tenantId: string,
	customerId: string,
	baseAt: string,
): string[] {
	const base = new Date(baseAt);
	const rhythms: Array<{ label: string; offsetMs: number }> = [
		{ label: "试驾后回访(24小时):确认试驾感受与疑虑", offsetMs: 24 * HOUR_MS },
		{ label: "试驾后回访(3天):推进报价/方案,询问竞品对比", offsetMs: 3 * 24 * HOUR_MS },
		{ label: "试驾后回访(7天):促成到店/成交,或转入长线培育", offsetMs: 7 * 24 * HOUR_MS },
	];
	const actions: string[] = [];
	for (const r of rhythms) {
		const due = new Date(base.getTime() + r.offsetMs).toISOString();
		createTask(db, { tenantId, customerId, action: r.label, dueAt: due });
		actions.push(r.label);
	}
	return actions;
}

/** 提车关怀:成交后第 3 天回访用车体验,第 30 天提醒保养/转介绍。 */
export function scheduleDeliveryFollowups(db: DatabaseSync, tenantId: string, customerId: string, dealedAt: string): string[] {
	const base = new Date(dealedAt);
	const rhythms: Array<{ label: string; offsetMs: number }> = [
		{ label: "提车关怀(3天):确认用车体验,收集满意度", offsetMs: 3 * 24 * HOUR_MS },
		{ label: "保养提醒(30天):首保/保养邀约,老带新转介绍", offsetMs: 30 * 24 * HOUR_MS },
	];
	const actions: string[] = [];
	for (const r of rhythms) {
		const due = new Date(base.getTime() + r.offsetMs).toISOString();
		createTask(db, { tenantId, customerId, action: r.label, dueAt: due });
		actions.push(r.label);
	}
	return actions;
}