// 路由层公共辅助(deps 类型、角色/门店范围解析)
import type { DatabaseSync } from "node:sqlite";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { FastifyInstance } from "fastify";
import type { ModelRuntime } from "../../integrations_pi/models.js";
import type { ReminderQueue } from "../../integrations_db/reminder-queue.js";
import type { SessionStore } from "../../integrations_pi/sessions.js";
import { getSalespersonById, upsertSalesperson } from "../../integrations_pi/tables/sales/stores.js";
/** 销售上下文(原 v1 pi/business/analysis.ts 的类型,现归路由层) */
export interface SalesContext {
	salesName?: string;
	salesId?: string;
	salesPhone?: string;
	storeId?: string;
}


// 给 Fastify 的 FastifyRequest 声明租户字段(v1 里这段声明在 app.ts,搬过来后归路由层公共文件)
declare module "fastify" {
	interface FastifyRequest {
		tenantId: string;
	}
}

export interface RouteDeps {
	db: DatabaseSync;
	store: SessionStore;
	dataDir: string;
	/** 运行日志目录(logging.dir 解析后的绝对路径) */
	logDir: string;
	runtime?: ModelRuntime;
	streamFn?: StreamFn;
	reminders: ReminderQueue;
}

export function pickStr(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** 从请求体与请求头解析销售/门店上下文(body 优先,兼容 x-sales-* 头)。 */
export function salesContextFrom(body: Record<string, unknown> | undefined, headers: Record<string, string | string[] | undefined>): SalesContext {
	const b = body ?? {};
	return {
		salesName: pickStr(b.salesName ?? headers["x-sales-name"]),
		salesId: pickStr(b.salesId ?? headers["x-sales-id"]),
		salesPhone: pickStr(b.salesPhone ?? headers["x-sales-phone"]),
		storeId: pickStr(b.storeId ?? headers["x-store-id"]),
	};
}

/** 店长数据范围:带 x-sales-id 且角色为 manager 时,只能访问所属门店;越权返回 denied。 */
export async function resolveManagerScope(
	db: DatabaseSync,
	tenantId: string,
	headers: Record<string, string | string[] | undefined>,
	requestedStoreId?: string,
): Promise<{ storeId?: string; denied?: boolean }> {
	const salesId = pickStr(headers["x-sales-id"]);
	if (!salesId) return { storeId: requestedStoreId };
	const sale = getSalespersonById(db, tenantId, salesId);
	if (!sale || sale.role !== "manager") return { storeId: requestedStoreId };
	if (requestedStoreId && requestedStoreId !== sale.store_id) return { denied: true };
	return { storeId: sale.store_id ?? undefined };
}

/** 有销售标识时同步 sales 台账(门店/姓名/电话),返回解析后的销售上下文。 */
export function resolveSalesperson(db: DatabaseSync, tenantId: string, sales: SalesContext): SalesContext {
	if (!sales.salesId) return sales;
	const sp = upsertSalesperson(db, tenantId, { storeId: sales.storeId, name: sales.salesName ?? "未知销售", phone: sales.salesPhone, role: "sales" });
	return { salesName: sp.name, salesId: sp.id, salesPhone: sp.phone ?? undefined, storeId: sp.store_id ?? undefined };
}

/** 统一注册入口类型:各路由模块共用。 */
export type RegisterRoutes = (app: FastifyInstance, deps: RouteDeps) => void;
