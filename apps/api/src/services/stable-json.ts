/** 稳定 JSON 序列化:对象键按字母序排序,保证相同逻辑参数得到相同串(用于缓存键)。 */
export function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return "{" + Object.keys(record).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(record[k])).join(",") + "}";
	}
	return JSON.stringify(value);
}