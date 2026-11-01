/**
 * 租户隔离的"强制性"检查(应用层强制)。
 *
 * 背景:共享库 + tenant_id 的方案里,隔离完全依赖"每个开发者都记得写 WHERE tenant_id = ?",
 * 漏写一次就是跨租户串数据。MySQL 没有 PostgreSQL 的行级安全(RLS),所以这里把强制点下沉到
 * 统一的 prepare / exec 入口。
 *
 * 判定粒度是**表**:语句里出现的每一张业务表,都必须有自己的租户谓词,或者通过同一租户的镜像表
 * (如 knowledge_chunks_fts 之于 knowledge_chunks)带上租户谓词。这样"JOIN 只在一边写租户条件"
 * 这类只写半边条件的语句会被拦下 —— 它和下表行的等价写法才是安全的:
 *
 *   SELECT c.* FROM customers c JOIN stores s ON c.store_id = s.id
 *    WHERE c.tenant_id = ? AND s.tenant_id = ?
 *
 * 允许的例外:
 *   - 语句里显式带 /* system *​/ 注释:租户枚举、建表、迁移、清库这类本来就要跨租户的操作,
 *     由调用方显式标记,把"忘了写"变成"故意写";
 *   - DDL 与 SQLite 的事务控制语句(BEGIN/COMMIT/ROLLBACK/PRAGMA)。
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

/** 与业务表同源的镜像表后缀(如 SQLite FTS 索引 knowledge_chunks_fts):租户条件写在镜像表上等价于写在业务表上。 */
const MIRROR_SUFFIX = "_fts";

/** 这些词出现在 FROM/JOIN 之后是关键字,不是表别名。 */
const KEYWORDS = new Set([
	"where", "on", "using", "join", "left", "right", "inner", "outer", "cross", "full", "natural",
	"group", "order", "limit", "having", "union", "set", "values", "select", "and", "or", "as",
	"straight_join", "window", "for", "lock", "partition", "index", "force", "use", "ignore", "not", "exists",
]);

const warned = new Set<string>();

/** 归一化 SQL:去掉多余空白,便于匹配与日志。 */
function normalize(sql: string): string {
	return String(sql ?? "").replace(/\s+/g, " ").trim();
}

/** 去掉反引号与 SQL 注释,避免注释里的表名/列名参与判定。 */
function stripNoise(sql: string): string {
	return sql
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.replace(/--[^\n]*/g, " ")
		.replace(/`/g, "")
		.toLowerCase();
}

interface TableRef {
	table: string;
	alias: string;
}

/** 抽出语句里引用的表(含别名)。表位置才认:FROM / JOIN / INSERT INTO / UPDATE / DELETE FROM。 */
function extractRefs(text: string): { reads: TableRef[]; writes: TableRef[]; insert: boolean } {
	const reads: TableRef[] = [];
	const writes: TableRef[] = [];
	const take = (list: TableRef[], raw: string | undefined, aliasRaw: string | undefined): void => {
		if (!raw) return;
		const table = raw.toLowerCase();
		const alias = aliasRaw && !KEYWORDS.has(aliasRaw.toLowerCase()) ? aliasRaw.toLowerCase() : table;
		list.push({ table, alias });
	};
	for (const m of text.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_]*)(?:\s+(?:as\s+)?([a-z_][a-z0-9_]*))?/g)) {
		if (KEYWORDS.has(m[1].toLowerCase())) continue;
		take(reads, m[1], m[2]);
	}
	for (const m of text.matchAll(/\bupdate\s+([a-z_][a-z0-9_]*)(?:\s+(?:as\s+)?([a-z_][a-z0-9_]*))?/g)) {
		if (KEYWORDS.has(m[1].toLowerCase())) continue;
		take(writes, m[1], m[2]);
	}
	for (const m of text.matchAll(/\bdelete\s+from\s+([a-z_][a-z0-9_]*)(?:\s+(?:as\s+)?([a-z_][a-z0-9_]*))?/g)) {
		if (KEYWORDS.has(m[1].toLowerCase())) continue;
		take(writes, m[1], m[2]);
	}
	const insert = /\binsert\s+(?:or\s+\w+\s+)?(?:ignore\s+)?into\b/.test(text);
	return { reads, writes, insert };
}

/**
 * 抽出"绑定到具体租户"的谓词限定符:
 *   tenant_id = ?            → 无限定符(整句级绑定)
 *   c.tenant_id = ?          → 限定符 c
 *   tenant_id IN (?,?)       → 无限定符
 *   a.tenant_id = b.tenant_id→ 只是同租户 JOIN,不构成绑定(两边都没锚到具体租户)
 */
function extractTenantBindings(text: string): { qualifiers: Set<string>; unqualified: boolean } {
	const qualifiers = new Set<string>();
	let unqualified = false;
	const re = /(?:([a-z_][a-z0-9_]*)\s*\.\s*)?tenant_id\s*(=|<>|!=|>=|<=|>|<|\bin\b|\blike\b|\bbetween\b)/g;
	for (const m of text.matchAll(re)) {
		const qualifier = m[1]?.toLowerCase();
		const operator = m[2].toLowerCase();
		const rest = text.slice((m.index ?? 0) + m[0].length);
		// a.tenant_id = b.tenant_id:同租户 JOIN,不锚定租户,两边都不算绑定
		if (operator === "=" && /^\s*(?:[a-z_][a-z0-9_]*\s*\.\s*)?tenant_id\b/.test(rest)) continue;
		if (qualifier) qualifiers.add(qualifier);
		else unqualified = true;
	}
	return { qualifiers, unqualified };
}

/**
 * 抽出"同租户等值 JOIN"(a.tenant_id = b.tenant_id)。
 * 这类条件本身不锚定租户,但会把两张表绑成一个租户组:组里只要有一张表锚到具体租户,
 * 其余表就被同一租户约束住了 —— 这正是 LEFT JOIN 补表最自然的写法(不用再多传一个参数)。
 */
function extractTenantLinks(text: string): Array<[string, string]> {
	const links: Array<[string, string]> = [];
	for (const m of text.matchAll(/([a-z_][a-z0-9_]*)\s*\.\s*tenant_id\s*=\s*([a-z_][a-z0-9_]*)\s*\.\s*tenant_id/g)) {
		links.push([m[1].toLowerCase(), m[2].toLowerCase()]);
	}
	return links;
}

export interface TenantScope {
	/** 语句里出现的业务表(物理名,去重) */
	tables: string[];
	/** 没有租户谓词的业务表(非空即违规) */
	uncovered: string[];
	/** 整句是否出现租户谓词(兼容旧判定,给人看的) */
	hasTenantPredicate: boolean;
	systemScoped: boolean;
}

/**
 * 检查一条语句的租户作用域。
 * 判定刻意保守但**逐表**:每张业务表都要有租户谓词(自己的、或同源镜像表的)。
 */
export function inspectTenantScope(sql: string, tables: Record<string, string>): TenantScope {
	const raw = normalize(sql).toLowerCase();
	const systemScoped = raw.includes(SYSTEM_SCOPE_MARK);
	const text = stripNoise(String(sql ?? ""));
	// 逻辑表名 / 物理表名 → 统一映射到"业务表标识",便于镜像表与改名场景
	const resolve = (name: string): string | undefined => {
		const key = name.toLowerCase();
		for (const [logical, physical] of Object.entries(tables)) {
			if (logical === "tenants") continue;
			const value = String(physical).toLowerCase();
			if (value === "") continue;
			if (key === logical.toLowerCase() || key === value) return value;
			// 同源镜像表(如 knowledge_chunks_fts)→ 归到它对应的业务表
			if (key === `${value}${MIRROR_SUFFIX}` || key === `${logical.toLowerCase()}${MIRROR_SUFFIX}`) return value;
		}
		return undefined;
	};

	const { reads, writes, insert } = extractRefs(text);
	const refs: TableRef[] = [...reads, ...writes];
	if (insert) {
		// INSERT 没有 WHERE:要求列清单/取值里带 tenant_id
		for (const m of text.matchAll(/\binsert\s+(?:or\s+\w+\s+)?(?:ignore\s+)?into\s+([a-z_][a-z0-9_]*)/g)) {
			const alias = m[1].toLowerCase();
			if (!refs.some((r) => r.table === alias)) refs.push({ table: alias, alias });
		}
	}

	const byBase = new Map<string, Set<string>>(); // 业务表 → 指向它的全部别名
	for (const ref of refs) {
		const base = resolve(ref.table);
		if (!base) continue;
		const aliases = byBase.get(base) ?? new Set<string>();
		aliases.add(ref.alias);
		aliases.add(ref.table);
		byBase.set(base, aliases);
	}
	const businessTables = [...byBase.keys()];
	if (businessTables.length === 0) {
		return { tables: [], uncovered: [], hasTenantPredicate: /\btenant_id\b/.test(text), systemScoped };
	}

	const { qualifiers, unqualified } = extractTenantBindings(text);
	const hasTenantPredicate = /\btenant_id\b/.test(text);

	// 别名 → 业务表,便于把"同租户等值 JOIN"换算成表与表之间的连线
	const baseOfAlias = new Map<string, string>();
	for (const ref of refs) {
		const base = resolve(ref.table);
		if (!base) continue;
		baseOfAlias.set(ref.alias, base);
		baseOfAlias.set(ref.table, base);
	}

	// 并查集:被"同租户等值 JOIN"连起来的表算一个租户组
	const parent = new Map<string, string>();
	const find = (x: string): string => {
		let root = parent.get(x) ?? x;
		while (root !== (parent.get(root) ?? root)) root = parent.get(root) ?? root;
		parent.set(x, root);
		return root;
	};
	const union = (a: string, b: string): void => {
		const ra = find(a);
		const rb = find(b);
		if (ra !== rb) parent.set(ra, rb);
	};
	for (const base of businessTables) parent.set(base, base);
	for (const [left, right] of extractTenantLinks(text)) {
		const a = baseOfAlias.get(left);
		const b = baseOfAlias.get(right);
		if (a && b && a !== b) union(a, b);
	}

	const coveredGroups = new Set<string>();
	for (const [base, aliases] of byBase) {
		if ([...aliases].some((alias) => qualifiers.has(alias))) coveredGroups.add(find(base));
	}
	// 无限定符的谓词只覆盖"整句只涉及一张业务表"的情况(多表时 SQL 本身也会因列名歧义报错)
	if (unqualified && businessTables.length === 1) coveredGroups.add(find(businessTables[0]));

	const uncovered: string[] = [];
	for (const [base, aliases] of byBase) {
		if (insert) {
			// INSERT 没有 WHERE:列清单或取值里带 tenant_id 即视为隔离
			if (!hasTenantPredicate) uncovered.push(base);
			continue;
		}
		void aliases;
		if (!coveredGroups.has(find(base))) uncovered.push(base);
	}
	return { tables: businessTables, uncovered, hasTenantPredicate, systemScoped };
}

function isStructuralStatement(sql: string): boolean {
	const text = stripNoise(sql).trim();
	if (!text) return true;
	return /^(begin|commit|end|rollback|savepoint|release|pragma|create|alter|drop|truncate|rename|analyze|optimize|attach|detach|vacuum|set)\b/.test(text);
}

/**
 * 检查一条将要执行的语句;mode=enforce 时违规直接抛错,mode=warn 时只告警一次。
 */
export function inspectAndGuard(sql: string, options: TenantGuardOptions): { ok: boolean; tables: string[] } {
	const scope = inspectTenantScope(sql, options.tables);
	if (options.mode === "off") return { ok: true, tables: [] };
	if (scope.systemScoped || scope.tables.length === 0 || scope.uncovered.length === 0) {
		return { ok: true, tables: scope.tables };
	}
	const table = scope.uncovered[0];
	const detail = `涉及业务表 ${scope.uncovered.join("/")} 但没有各自的租户谓词(tenant_id)`;
	if (options.onViolation) {
		options.onViolation({ table, sql: normalize(sql).slice(0, 200), mode: options.mode });
	} else {
		const key = `${options.mode}:${scope.uncovered.join(",")}`;
		if (!warned.has(key)) {
			warned.add(key);
			console.warn(`[tenant-guard] ${detail},mode=${options.mode}:${normalize(sql).slice(0, 160)}`);
		}
	}
	if (options.mode === "enforce") {
		throw new Error(
			`租户隔离拦截:${detail}。` +
				`请为每张业务表补上租户过滤,或对系统级语句加 ${SYSTEM_SCOPE_MARK} 标记。SQL: ${normalize(sql).slice(0, 160)}`,
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
 * 给数据库句柄套一层守卫:prepare 与 exec 都先过检查。
 * 对 SQLite(DatabaseSync)与项目的 MySQL 同步桥都适用 —— 它们都只有 prepare/exec 这两个入口,
 * 两个入口都包住,才不会出现"换一个方法调用就绕过"的缺口。
 */
export function withTenantGuard<TDb extends { prepare: PrepareLike<unknown> }>(db: TDb, options: TenantGuardOptions): TDb {
	const original = db.prepare.bind(db) as PrepareLike<unknown>;
	db.prepare = ((sql: string) => {
		inspectAndGuard(sql, options);
		return original(sql);
	}) as TDb["prepare"];

	const target = db as unknown as { exec?: (sql: string) => void };
	if (typeof target.exec === "function") {
		const originalExec = target.exec.bind(db);
		target.exec = (sql: string) => {
			// exec 只用于事务控制与 DDL;一旦有人拿它跑业务 DML/查询,同样要过守卫
			if (!isStructuralStatement(sql)) inspectAndGuard(sql, options);
			originalExec(sql);
		};
	}
	return db;
}
