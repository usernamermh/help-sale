import { Type } from "typebox";
import type { DatabaseSync } from "node:sqlite";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { externalToolByName, externalToolPaths } from "../services/external-tools.js";

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

/** 系统收口工具:输出优选方案(不随 tools 目录加载)。 */
export function emitVehiclePlanTool(): AgentTool<any, any> {
	return {
		name: "emit_vehicle_plan",
		label: "输出优选方案",
		description: "输出车型优选的结构化最终方案。调用后立即停止。",
		parameters: Type.Object({
			profile: Type.String({ description: "客户需求画像" }),
			recommendations: Type.Array(
				Type.Object({
					brand: Type.String(),
					series: Type.String(),
					modelName: Type.String(),
					priceText: Type.String(),
					energyType: Type.String(),
					bodyType: Type.String(),
					seats: Type.Number(),
					fitScore: Type.Number(),
					reason: Type.String(),
				}),
				{ minItems: 1, maxItems: 3 },
			),
			keyDifferences: Type.Array(Type.String()),
			suggestedReply: Type.String(),
			nextSteps: Type.Array(Type.String()),
		}),
		async execute(_toolCallId, params: any) {
			return {
				content: [{ type: "text" as const, text: `优选完成:${params.recommendations.length} 款` }],
				details: params as VehiclePlanDetails,
				terminate: true,
			};
		},
	};
}

/** 车型优选工具:vehicle_query 来自 tools 目录,emit_vehicle_plan 系统收口。 */
export async function createVehicleTools(deps: { db: DatabaseSync; tenantId: string }): Promise<Array<AgentTool<any, any>>> {
	const search = await externalToolByName(externalToolPaths(), { db: deps.db, tenantId: deps.tenantId }, "vehicle_query");
	return [search, emitVehiclePlanTool()];
}