/**
 * 表映射自检:启动时比对"两份 schema 里的表"与 `data.tables` 的**键**。
 *
 * 为什么只比键:data.tables 是"逻辑表名 → 实际物理表名"的映射,部署时允许把物理表改名
 * (例如 customers → crm_customers),所以值不需要与 schema 一致;但**键必须齐全** ——
 * 租户隔离守卫正是按这份映射决定"哪些表算业务表",漏一个键,那张表的 SQL 就不会被强制要求带 tenant_id。
 *
 * 新增业务表时的固定动作:schema.sql + mysql/schema.sql 加表 → 两份 yaml 的 data.tables 加键 → 启动自检通过。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface MappingAudit {
	/** 两份 schema 里出现的全部表名(并集) */
	schemaTables: string[];
	/** schema 里有、但映射里没有键的表(会导致守卫不覆盖 → 必须修) */
	missingKeys: string[];
	/** 映射里有、但 schema 里没有的表(自定义表,允许,仅提示) */
	extraKeys: string[];
}

/** 从 schema 文件里提取表名(只认 CREATE TABLE IF NOT EXISTS)。 */
export function schemaTableNames(schemaFile: string): string[] {
	const sql = readFileSync(schemaFile, "utf8");
	return [...sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+`?([A-Za-z_][A-Za-z0-9_]*)`?/gi)].map((m) => m[1]);
}

function defaultSchemaPaths(): { sqlite: string; mysql: string } {
	const here = path.dirname(fileURLToPath(import.meta.url));
	return { sqlite: path.join(here, "schema.sql"), mysql: path.join(here, "mysql", "schema.sql") };
}

/** 比对映射与 schema;不改任何状态,供启动自检与测试使用。 */
export function auditTableMapping(
	mapping: Record<string, string>,
	paths?: { sqlite?: string; mysql?: string },
): MappingAudit {
	const fallback = defaultSchemaPaths();
	const names = new Set<string>();
	for (const file of [paths?.sqlite ?? fallback.sqlite, paths?.mysql ?? fallback.mysql]) {
		for (const name of schemaTableNames(file)) names.add(name);
	}
	const keys = new Set(Object.keys(mapping));
	const schemaTables = [...names].sort();
	return {
		schemaTables,
		missingKeys: schemaTables.filter((name) => !keys.has(name)),
		extraKeys: [...keys].filter((key) => !names.has(key)).sort(),
	};
}

/** 启动自检:缺键直接抛错并点名,避免"新表没进映射 → 守卫不覆盖"这种静默漏洞。 */
export function assertTableMappingComplete(
	mapping: Record<string, string>,
	paths?: { sqlite?: string; mysql?: string },
): MappingAudit {
	const audit = auditTableMapping(mapping, paths);
	if (audit.missingKeys.length > 0) {
		throw new Error(
			`data.tables 缺少 ${audit.missingKeys.length} 张表的映射:${audit.missingKeys.join(", ")}。` +
				`新增表时请在 backend/db/schema.sql 与 backend/db/mysql/schema.sql 之外,同步补上 help-sale.config.yaml 的 data.tables 键 —— ` +
				`租户隔离守卫按这份映射决定覆盖范围。`,
		);
	}
	return audit;
}