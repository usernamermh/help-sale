/**
 * 租户上下文的权威解析。
 *
 * 原则:租户 ID 是路由与隔离的权威数据,不能由调用方随便声明。
 * 解析顺序:
 *   1) 调用方凭证(Authorization: Bearer <apiKey> 或 x-api-key)→ 查租户映射,命中即权威;
 *      若同时带了 x-tenant-id 且与映射不一致 → 直接拒绝(防止"拿着 A 的钥匙开 B 的门");
 *   2) 未带凭证时:是否允许用请求头声明租户由 tenant.headerTenantAllowed 决定
 *      (开发/内网可以开,生产应关掉,只认凭证);
 *   3) 请求头声明的租户必须落在 tenant.trustedTenantIds 清单里(清单为空表示不限制);
 *   4) 都没有时落到配置里的默认租户。
 */
export interface TenantResolutionInput {
	headers: Record<string, string | string[] | undefined>;
	apiKeys: Record<string, string>;
	headerAllowed: boolean;
	trustedTenantIds: string[];
	defaultTenantId: string;
}

export interface TenantResolution {
	tenantId?: string;
	source: "api-key" | "header" | "default";
	/** 非空表示应当拒绝该请求 */
	error?: { status: 401 | 403; message: string };
}

function firstHeader(value: string | string[] | undefined): string {
	if (Array.isArray(value)) return String(value[0] ?? "").trim();
	return String(value ?? "").trim();
}

/** 从 Authorization: Bearer xxx 或 x-api-key 里取调用方 Key。 */
export function extractApiKey(headers: Record<string, string | string[] | undefined>): string {
	const direct = firstHeader(headers["x-api-key"]);
	if (direct) return direct;
	const authorization = firstHeader(headers.authorization);
	const match = /^Bearer\s+(.+)$/i.exec(authorization);
	return match ? match[1].trim() : "";
}

export function resolveTenant(input: TenantResolutionInput): TenantResolution {
	const apiKey = extractApiKey(input.headers);
	const headerTenant = firstHeader(input.headers["x-tenant-id"]);

	if (apiKey) {
		const mapped = input.apiKeys[apiKey];
		if (!mapped) return { source: "api-key", error: { status: 401, message: "API Key 无效或已失效" } };
		if (headerTenant && headerTenant !== mapped) {
			return { source: "api-key", error: { status: 403, message: "请求头声明的租户与 API Key 归属不一致" } };
		}
		return { tenantId: mapped, source: "api-key" };
	}

	if (headerTenant) {
		if (!input.headerAllowed) {
			return { source: "header", error: { status: 401, message: "未提供调用凭证(该部署不允许用请求头声明租户)" } };
		}
		if (input.trustedTenantIds.length > 0 && !input.trustedTenantIds.includes(headerTenant)) {
			return { source: "header", error: { status: 403, message: `租户 ${headerTenant} 不在受信清单内` } };
		}
		return { tenantId: headerTenant, source: "header" };
	}

	if (!input.headerAllowed && Object.keys(input.apiKeys).length > 0) {
		return { source: "default", error: { status: 401, message: "未提供调用凭证" } };
	}
	return { tenantId: input.defaultTenantId, source: "default" };
}