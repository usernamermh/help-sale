import type { DatabaseSync } from "node:sqlite";
import { getCustomer, listCustomers, upsertCustomer, type CustomerRow } from "../repositories/customers.js";
import { config } from "../env.js";

/**
 * 把入参(客户 key 或客户姓名)解析为客户记录:
 * 1. 先按 key 精确查询;
 * 2. key 未命中时,按姓名在客户清单中匹配(相等或互相包含);
 * 3. 仍无则按 key 建档。
 * 解决模型用错/编造 customerKey 时查不到真实客户的问题。
 */
export function resolveCustomerByKeyOrName(db: DatabaseSync, tenantId: string, keyOrName: string): CustomerRow {
	const input = String(keyOrName ?? "").trim();
	if (!input) return upsertCustomer(db, { tenantId, key: `c_${Date.now().toString(36)}` });
	let row = getCustomer(db, tenantId, input);
	if (!row) {
		const brief = listCustomers(db, tenantId, config.customersLimit).find((c) => {
			if (!c.name) return false;
			return c.name === input || c.name.includes(input) || input.includes(c.name);
		});
		if (brief) {
			const hit = getCustomer(db, tenantId, brief.key);
			if (hit) row = hit;
		}
	}
	if (!row) row = upsertCustomer(db, { tenantId, key: input });
	return row;
}