import type { DatabaseSync } from "node:sqlite";
import { getCustomer } from "./customers.js";

/** 销售漏斗标准阶段:新进店→已联系→试驾→报价→成交/战败 */
export const FUNNEL_STAGES = ["new", "contacted", "test_drive", "quote", "closed_won", "closed_lost"] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

export const LOST_REASONS = ["price", "competitor", "waiting", "disappeared", "other"] as const;
export type LostReason = (typeof LOST_REASONS)[number];

export interface FunnelStageStats {
	stage: FunnelStage | string;
	count: number;
	share: number; // 占全部客户比例
	avgStayDays: number | null; // 当前阶段平均停留天数
}

export interface FunnelStats {
	total: number;
	stages: FunnelStageStats[];
	conversions: Array<{ from: string; to: string; rate: number }>;
	lostReasons: Array<{ reason: string; count: number }>;
}

export interface FunnelCustomer {
	id: string;
	key: string;
	name: string | null;
	phone: string | null;
	funnelStage: string | null;
	lostReason: string | null;
	lastActiveAt: string | null;
}

/** 阶段流转:设置客户漏斗阶段(可选战败原因),记录进入阶段时间。 */
export function setFunnelStage(
	db: DatabaseSync,
	tenantId: string,
	customerKey: string,
	stage: string,
	lostReason?: string,
): FunnelCustomer | undefined {
	const row = getCustomer(db, tenantId, customerKey);
	if (!row) return undefined;
	if (!FUNNEL_STAGES.includes(stage as FunnelStage)) throw new Error(`阶段不合法:${stage}(可选 ${FUNNEL_STAGES.join("/")})`);
	db.prepare(
		`UPDATE customers
		 SET funnel_stage = ?, lost_reason = CASE WHEN ? = 'closed_lost' THEN ? ELSE lost_reason END,
		     funnel_stage_changed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
		     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
		 WHERE id = ?`,
	).run(stage, stage, lostReason ?? null, row.id);
	return funnelCustomerRow(db, row.id);
}

/** 把客户行映射为漏斗视图行(兼容 mysql 同步桥的行命名)。 */
export function funnelCustomerRow(db: DatabaseSync, customerId: string): FunnelCustomer {
	const r = db.prepare("SELECT * FROM customers WHERE id = ?").get(customerId) as Record<string, unknown>;
	return {
		id: String(r.id),
		key: String(r.key),
		name: r.name ? String(r.name) : null,
		phone: r.phone ? String(r.phone) : null,
		funnelStage: r.funnel_stage ? String(r.funnel_stage) : null,
		lostReason: r.lost_reason ? String(r.lost_reason) : null,
		lastActiveAt: r.funnel_stage_changed_at ? String(r.funnel_stage_changed_at) : null,
	};
}

/** 门店客户子集:通过会话归属门店(storeId 为空则全租户)。 */
function storeCustomerFilter(db: DatabaseSync, tenantId: string, storeId?: string): { clause: string; params: Array<string | number> } {
	if (!storeId) return { clause: "", params: [] };
	return {
		clause: " AND c.id IN (SELECT DISTINCT customer_id FROM conversations WHERE tenant_id = ? AND store_id = ? AND customer_id IS NOT NULL)",
		params: [tenantId, storeId],
	};
}

/** 漏斗统计:各阶段数量/占比/平均停留、关键转化率、战败原因分布。 */
export function getFunnelStats(db: DatabaseSync, tenantId: string, storeId?: string, now = new Date()): FunnelStats {
	const { clause, params } = storeCustomerFilter(db, tenantId, storeId);
	const total = (
		db.prepare(`SELECT COUNT(*) AS n FROM customers c WHERE c.tenant_id = ?${clause}`).get(tenantId, ...params) as { n: number }
	).n;

	const stageRows = db
		.prepare(
			`SELECT COALESCE(funnel_stage, 'new') AS stage_key, COUNT(*) AS count,
			        AVG(CASE WHEN funnel_stage_changed_at IS NOT NULL THEN (unixepoch(?) - unixepoch(funnel_stage_changed_at)) / 86400.0 END) AS avg_days
			 FROM customers c WHERE c.tenant_id = ?${clause}
			 GROUP BY stage_key ORDER BY CASE stage_key WHEN 'new' THEN 1 WHEN 'contacted' THEN 2 WHEN 'test_drive' THEN 3 WHEN 'quote' THEN 4 WHEN 'closed_won' THEN 5 WHEN 'closed_lost' THEN 6 ELSE 7 END`,
		)
		.all(now.toISOString(), tenantId, ...params) as Array<{ stage_key: string; count: number; avg_days: number | null }>;

	const stages: FunnelStageStats[] = stageRows.map((r) => ({
		stage: r.stage_key,
		count: r.count,
		share: total > 0 ? r.count / total : 0,
		avgStayDays: r.avg_days != null ? Math.round(r.avg_days * 10) / 10 : null,
	}));

	const countOf = (stage: string) => stageRows.find((r) => r.stage_key === stage)?.count ?? 0;
	const newCount = countOf("new");
	const conversions = [
		{ from: "全部", to: "已联系", rate: total > 0 ? (total - newCount) / total : 0 },
		{ from: "全部", to: "试驾", rate: total > 0 ? countOf("test_drive") / total : 0 },
		{ from: "全部", to: "报价", rate: total > 0 ? countOf("quote") / total : 0 },
		{ from: "全部", to: "成交", rate: total > 0 ? countOf("closed_won") / total : 0 },
	];

	const lostRows = db
		.prepare(
			`SELECT COALESCE(lost_reason, 'other') AS reason, COUNT(*) AS count
			 FROM customers c WHERE c.tenant_id = ? AND c.funnel_stage = 'closed_lost'${clause}
			 GROUP BY reason ORDER BY count DESC`,
		)
		.all(tenantId, ...params) as Array<{ reason: string; count: number }>;

	return { total, stages, conversions, lostReasons: lostRows };
}

/** 沉默客户:N 天内无会话/任务/试驾记录的客户(默认 7 天)。 */
/** 沉默客户:N 天内无会话/任务/试驾记录的客户(默认 7 天);时间基准用传入 now(默认为当前时间),保证测试可注入固定时间。 */
export function listSilentCustomers(db: DatabaseSync, tenantId: string, days = 7, storeId?: string, now: Date = new Date()): FunnelCustomer[] {
	const { clause, params } = storeCustomerFilter(db, tenantId, storeId);
	const since = new Date(now.getTime() - days * 86400000).toISOString();
	const rows = db
		.prepare(
			`SELECT c.* FROM customers c
			 WHERE c.tenant_id = ? AND COALESCE(c.funnel_stage, 'new') NOT IN ('closed_won', 'closed_lost')${clause}
			   AND NOT EXISTS (SELECT 1 FROM conversations cv WHERE cv.tenant_id = c.tenant_id AND cv.customer_id = c.id AND cv.updated_at >= ?)
			   AND NOT EXISTS (SELECT 1 FROM next_step_tasks t WHERE t.tenant_id = c.tenant_id AND t.customer_id = c.id AND t.status = 'pending' AND (t.due_at IS NULL OR t.due_at >= ?))
			   AND NOT EXISTS (SELECT 1 FROM test_drives td WHERE td.tenant_id = c.tenant_id AND td.customer_id = c.id AND td.scheduled_at >= ?)
			 LIMIT 200`,
		)
		.all(tenantId, since, since, since, ...params) as Record<string, unknown>[];
	return rows.map((r) => ({
		id: String(r.id),
		key: String(r.key),
		name: r.name ? String(r.name) : null,
		phone: r.phone ? String(r.phone) : null,
		funnelStage: r.funnel_stage ? String(r.funnel_stage) : null,
		lostReason: r.lost_reason ? String(r.lost_reason) : null,
		lastActiveAt: r.funnel_stage_changed_at ? String(r.funnel_stage_changed_at) : null,
	}));
}