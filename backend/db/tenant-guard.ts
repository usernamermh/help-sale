/**
 * 租户隔离的"强制性"检查(应用层强制)。
 *
 * 背景:共享库 + tenant_id 的方案里,隔离完全依赖"每个开发者都记得写 WHERE tenant_id = ?",
 * 漏写一次就是跨租户串数据。MySQL 没有 PostgreSQL 的行级安全(RLS),所以这里把强制点下沉到
 * **统一的 prepare 入口**:任何针对业务表的语句,只要整句里没有出现 tenant_id 谓词,就直接拦下。
 *
 * 逃生口:语句里显式带 /* system *\/ 注释表示这是系统级操作(租户枚举、建表、迁移、清库),
 * 这类语句本来就要跨租户,由调用方显式标记,不再靠"忘了写"。
 */

export type TenantIsolationMode = "off" | "warn" | "enforce";

export interface TenantGuardOptions {
	/** 业务表名 → 实际表名(config.tables) */
	tables: Record<string, string>;
	mode: TenantIsolationMode;
	/** 违规时的回调(便于日志与统计),默认打印告警 */
	onViolation?: (info: { table: string; sql: string; mode: TenantIsolationMode }) => void;
}

/** 系统级语句的显式标记。 */
export const SYSTEM_SCOPE_MARK = "/* system */";

const warned = new Set<string>();

/** 归一化 SQL:去掉多余空白,便于匹配与日志。 */
function normalize(sql: string): string {
	return String(sql ?? "").replace(/\s+/g, " ").trim();
}

/**
 * 找出这条语句里出现的业务表(不含 tenants 本身),以及是否带租户谓词。
 * 判定刻意保守:只要整句出现过 tenant_id 就算带过滤 —— 它抓的是"整句完全没提租户"这类经典漏写。
 */
export function inspectTenantScope(sql: string, tables: Record<string, string>): { tables: string[]; hasTenantPredicate: boolean; systemScoped: boolean } {
	const text = normalize(sql).toLowerCase();
	const systemScoped = text.includes(SYSTEM_SCOPE_MARK);
	const hit: string[] = [];
	for (const [key, name] of Object.entries(tables)) {
		if (key === "tenants") continue; // 租户表本身是全局的
		const table = String(name).toLowerCase();
		if (!table) continue;
		const pattern = new RegExp(`(^|[^a-z0-9_])${table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9_]|$)`);
		if (pattern.test(text)) hit.push(table);
	}
	return { tables: hit, hasTenantPredicate: /tenant_id/.test(text), systemScoped };
}

/**
 * 检查一条将要执行的语句;mode=enforce 时违规直接抛错,mode=warn 时只告警一次。
 * 返回检查结论,便于测试与统计。
 */
export function inspectAndGuard(sql: string, options: TenantGuardOptions): { ok: boolean; tables: string[] } {
	if (options.mode === "off") return { ok: true, tables: [] };
	const scope = inspectTenantScope(sql, options.tables);
	if (scope.systemScoped || scope.tables.length === 0 || scope.hasTenantPredicate) {
		return { ok: true, tables: scope.tables };
	}
	const table = scope.tables[0];
	const key = `${options.mode}:${table}`;
	if (options.onViolation) {
		options.onViolation({ table, sql: normalize(sql).slice(0, 200), mode: options.mode });
	} else if (!warned.has(key)) {
		warned.add(key);
		console.warn(
			`[tenant-guard] 语句涉及业务表 ${scope.tables.join("/")} 但没有租户谓词(tenant_id),` +
				`mode=${options.mode}:${normalize(sql).slice(0, 160)}`,
		);
	}
	if (options.mode === "enforce") {
		throw new Error(
			`租户隔离拦截:语句涉及业务表 ${scope.tables.join("/")} 但没有 tenant_id 条件。` +
				`请补上租户过滤,或对系统级语句加 ${SYSTEM_SCOPE_MARK} 标记。SQL: ${normalize(sql).slice(0, 160)}`,
		);
	}
	return { ok: false, tables: scope.tables };
}

/** 测试用:清空"只告警一次"的去重缓存。 */
export function resetTenantGuardWarnings(): void {
	warned.clear();
}

type PrepareLike<TStatement> = (sql: string) => TStatement;

/**
 * 给数据库句柄套一层守卫:所有 prepare 都先过检查。
 * 对 SQLite(DatabaseSync)与项目的 MySQL 同步桥都适用 —— 它们都只有 prepare/exec 这两个入口。
 */
export function withTenantGuard<TDb extends { prepare: PrepareLike<unknown> }>(
	db: TDb,
	options: TenantGuardOptions,
): TDb {
	const original = db.prepare.bind(db) as PrepareLike<unknown>;
	db.prepare = ((sql: string) => {
		inspectAndGuard(sql, options);
		return original(sql);
	}) as TDb["prepare"];
	return db;
}