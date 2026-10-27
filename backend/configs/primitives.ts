/**
 * 配置解析原语。
 *
 * 铁律:**代码里不写任何配置默认值**。每个配置项都必须由 help-sale.config.yaml 显式提供,
 * 缺失、类型不对、取值非法一律在加载配置时抛错并指出具体的配置键,绝不静默兜底。
 * 需要"关掉/留空"的项请在配置文件里显式写 `false` / `""` / `[]`,而不是省略。
 */

function label(key?: string): string {
	return key ? `配置项 ${key}` : "配置";
}

/** 布尔必填:必须是 true / false(也接受 yaml 里写成字符串的 "true"/"false"/"1"/"0")。 */
export function bool(value: unknown, key?: string): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "string" && value.trim() !== "") {
		const v = value.trim().toLowerCase();
		if (v === "true" || v === "1") return true;
		if (v === "false" || v === "0") return false;
	}
	throw new Error(`${label(key)} 缺少布尔值(在 help-sale.config.yaml 中显式写 true / false)`);
}

/** 数值必填:必须是数字(yaml 里写成数字字面量;数字字符串也接受)。空值/缺项/非数字一律报错。 */
export function num(value: unknown, key?: string): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
	throw new Error(`${label(key)} 缺少数值(在 help-sale.config.yaml 中显式写数字)`);
}

/** 字符串必填:必须显式给出该键;允许空串(写 `""`),但不允许缺项或写成 null。 */
export function str(value: unknown, key?: string): string {
	if (typeof value === "string") return value;
	throw new Error(`${label(key)} 缺少字符串(在 help-sale.config.yaml 中补齐;留空请显式写 "")`);
}

/** 字符串数组必填:必须显式给出该键;没有内容请显式写 `[]`。 */
export function strList(value: unknown, key?: string): string[] {
	if (Array.isArray(value)) return value.map(String);
	throw new Error(`${label(key)} 缺少数组(在 help-sale.config.yaml 中补齐;无内容请显式写 [])`);
}

/** 键值映射必填:必须显式给出该键;没有内容请显式写 `{}`(值不做类型限制)。 */
export function record(value: unknown, key?: string): Record<string, unknown> {
	if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
	throw new Error(`${label(key)} 缺少键值映射(在 help-sale.config.yaml 中补齐;无内容请显式写 {})`);
}

/** 字符串键值映射必填:键值都必须是字符串型配置(如 MCP 的 headers)。 */
export function strMap(value: unknown, key?: string): Record<string, string> {
	const source = record(value, key);
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(source)) out[k] = str(v, `${key ?? "映射"}.${k}`);
	return out;
}

/** 日志级别枚举校验:只允许 debug / info / error。 */
export function logLevel(value: unknown, key = "logging.level"): "debug" | "info" | "error" {
	const v = String(value ?? "").trim().toLowerCase();
	if (v === "debug" || v === "info" || v === "error") return v as "debug" | "info" | "error";
	throw new Error(`${label(key)} 必须为 debug / info / error(当前:${String(value)})`);
}

/** 向量后端枚举校验:只允许 sqlite / milvus。 */
export function vectorProvider(value: unknown, key = "vector.provider"): "sqlite" | "milvus" {
	const v = String(value ?? "").trim().toLowerCase();
	if (v === "sqlite" || v === "milvus") return v as "sqlite" | "milvus";
	throw new Error(`${label(key)} 必须为 sqlite 或 milvus(当前:${String(value)})`);
}

/** 数据存储模式枚举校验:只允许 local / mysql。 */
export function storageMode(value: unknown, key = "data.mode"): "local" | "mysql" {
	const v = String(value ?? "").trim().toLowerCase();
	if (v === "local" || v === "mysql") return v as "local" | "mysql";
	throw new Error(`${label(key)} 必须为 local 或 mysql(当前:${String(value)})`);
}

/** 业务表名映射校验:必须覆盖全部逻辑表,缺失或非法抛错(data.tables 是表名的唯一事实源)。 */
export function parseTables(value: unknown, key = "data.tables"): Record<string, string> {
	if (!value || typeof value !== "object") {
		throw new Error(`${label(key)} 缺失:请在 help-sale.config.yaml 的 data.tables 中配置全部业务表名`);
	}
	const inTables = value as Record<string, unknown>;
	const required = [
		"tenants", "customers", "conversations", "conversation_messages", "next_step_tasks",
		"knowledge_documents", "knowledge_chunks", "knowledge_candidates", "agent_events", "customer_tags",
		"notification_logs", "stores", "sales", "deals", "tool_call_cache", "digests",
	];
	const out: Record<string, string> = {};
	for (const tableKey of required) {
		const tableName = inTables[tableKey];
		if (typeof tableName !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) {
			throw new Error(`配置项 data.tables.${tableKey} 缺失或非法(应为合法表名):${String(tableName)}`);
		}
		out[tableKey] = tableName;
	}
	return out;
}
