import { Type } from "typebox";
import type { DatabaseSync } from "node:sqlite";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { getCustomer, upsertCustomer } from "../repositories/customers.js";
import { searchVehicles } from "../repositories/vehicles.js";

export interface VehicleRecommendation {
	brand: string;
	series: string;
	modelName: string;
	priceText: string;
	energyType: string;
	bodyType: string;
	seats: number;
	fitScore: number;
	reason: string;
}

export interface VehiclePlanDetails {
	profile: string;
	recommendations: VehicleRecommendation[];
	keyDifferences: string[];
	suggestedReply: string;
	nextSteps: string[];
}

export function createVehicleTools(deps: { db: DatabaseSync; tenantId: string }): Array<AgentTool<any, any>> {
	const { db, tenantId } = deps;

	const searchTool: AgentTool<any, any> = {
		name: "search_vehicles",
		label: "检索车型库",
		description:
			"在车型库中检索候选车型。可按预算区间(万元)、座位数、能源类型(纯电/插混/增程/混动/燃油)、级别、关键词过滤;返回车型、价格区间、卖点与适用场景。",
		parameters: Type.Object({
			budgetMin: Type.Optional(Type.Number({ description: "预算下限(万元)" })),
			budgetMax: Type.Optional(Type.Number({ description: "预算上限(万元)" })),
			seats: Type.Optional(Type.Number({ description: "座位数,如 5/7" })),
			energyType: Type.Optional(Type.String({ description: "能源类型:纯电/插混/增程/混动/燃油" })),
			bodyType: Type.Optional(Type.String({ description: "级别:轿车/SUV/MPV/微型车" })),
			keywords: Type.Optional(Type.String({ description: "关键词,如 商务/家庭/长续航" })),
		}),
		async execute(_toolCallId, params: any) {
			const hits = searchVehicles(db, {
				tenantId,
				budgetMin: params.budgetMin,
				budgetMax: params.budgetMax,
				seats: params.seats,
				energyType: params.energyType,
				bodyType: params.bodyType,
				keyword: params.keywords,
				limit: 10,
			});
			return {
				content: [
					{
						type: "text",
						text: hits.length
							? hits
									.map(
										(v) =>
											`【${v.brand} ${v.series} ${v.modelName}】 ${(v.priceMin + "-" + v.priceMax).replace(/\.0+/g, "")}万 / ${v.energyType} / ${v.bodyType} / ${v.seats}座\n定位:${v.positioning ?? "-"}\n卖点:${v.highlights ?? "-"}\n场景:${v.scenarios ?? "-"}`,
									)
									.join("\n\n")
							: "车型库无匹配,请如实告知缺口。",
					},
				],
				details: hits,
			};
		},
	};

	const profileTool: AgentTool<any, any> = {
		name: "get_customer_profile",
		label: "查看客户档案",
		description: "按客户 key 获取客户资料(名称/公司/阶段/备注)。",
		parameters: Type.Object({ customerKey: Type.String() }),
		async execute(_toolCallId, params: any) {
			let row = getCustomer(db, tenantId, params.customerKey);
			if (!row) row = upsertCustomer(db, { tenantId, key: params.customerKey });
			return {
				content: [
					{ type: "text", text: `客户:${row.name ?? params.customerKey}${row.company ? ` / ${row.company}` : ""}\n阶段:${row.stage ?? "未知"}\n备注:${row.notes ?? "无"}` },
				],
				details: row,
			};
		},
	};

	const emitTool: AgentTool<any, any> = {
		name: "emit_vehicle_plan",
		label: "输出优选方案",
		description: "输出本次车型优选的结构化方案,作为最终结果。调用后立即停止。",
		parameters: Type.Object({
			profile: Type.String({ description: "客户需求画像(预算/用途/人数/偏好)" }),
			recommendations: Type.Array(
				Type.Object({
					brand: Type.String(),
					series: Type.String(),
					modelName: Type.String(),
					priceText: Type.String({ description: "价格区间文本,如 19.98-25.98 万" }),
					energyType: Type.String(),
					bodyType: Type.String(),
					seats: Type.Number(),
					fitScore: Type.Number({ description: "匹配度 0-100" }),
					reason: Type.String({ description: "结合客户需求的推荐理由" }),
				}),
				{ minItems: 1, maxItems: 3 },
			),
			keyDifferences: Type.Array(Type.String()),
			suggestedReply: Type.String({ description: "可直接发送给客户的一段话" }),
			nextSteps: Type.Array(Type.String(), { minItems: 1 }),
		}),
		async execute(_toolCallId, params: any) {
			return {
				content: [{ type: "text", text: `优选方案已生成:${params.recommendations.length} 款车型` }],
				details: params as VehiclePlanDetails,
				terminate: true,
			};
		},
	};

	return [searchTool, profileTool, emitTool];
}