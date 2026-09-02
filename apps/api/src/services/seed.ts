import type { DatabaseSync } from "node:sqlite";
import { upsertVehicle, type VehicleInput } from "../repositories/vehicles.js";

/**
 * 示例车型种子数据:仅用于演示与联调,请替换为实际在售车型与真实价格。
 * 覆盖不同价位 / 能源类型 / 级别 / 座位数,便于车型优选的演示与测试。
 */
export const SEED_VEHICLES: Omit<VehicleInput, "tenantId">[] = [
	{
		brand: "五菱", series: "宏光MINI", modelName: "宏光MINI EV",
		energyType: "纯电", bodyType: "微型车", priceMin: 3.28, priceMax: 6.28, seats: 4,
		positioning: "城市代步", highlights: "小巧好停,用车成本低,支持快充",
		scenarios: "城市通勤、买菜接送、新手练手",
	},
	{
		brand: "比亚迪", series: "秦", modelName: "秦PLUS DM-i",
		energyType: "插混", bodyType: "轿车", priceMin: 9.98, priceMax: 13.98, seats: 5,
		positioning: "经济家用", highlights: "亏电油耗低,绿牌免购置税,配置均衡",
		scenarios: "家庭通勤、网约出行、预算 10 万级家用",
	},
	{
		brand: "比亚迪", series: "宋", modelName: "宋PLUS DM-i",
		energyType: "插混", bodyType: "SUV", priceMin: 13.58, priceMax: 17.58, seats: 5,
		positioning: "主力家用 SUV", highlights: "空间大,油耗低,智能驾驶辅助齐全",
		scenarios: "多口之家通勤、周末出行、15 万级 SUV",
	},
	{
		brand: "比亚迪", series: "汉", modelName: "汉EV 冠军版",
		energyType: "纯电", bodyType: "轿车", priceMin: 19.98, priceMax: 25.98, seats: 5,
		positioning: "商务舒适", highlights: "长续航,高级感内饰,驾驶质感好",
		scenarios: "商务接待、高里程通勤、20-25 万纯电轿车",
	},
	{
		brand: "特斯拉", series: "Model Y", modelName: "Model Y 后驱版",
		energyType: "纯电", bodyType: "SUV", priceMin: 24.99, priceMax: 27.99, seats: 5,
		positioning: "科技智能", highlights: "智驾体验强,超充网络完善,保值率高",
		scenarios: "科技人群、通勤加长途、25 万级纯电 SUV",
	},
	{
		brand: "理想", series: "理想L7", modelName: "理想L7 Pro",
		energyType: "增程", bodyType: "SUV", priceMin: 30.18, priceMax: 35.98, seats: 5,
		positioning: "家庭旗舰", highlights: "大五座,后排屏,增程无里程焦虑",
		scenarios: "有娃家庭、带娃长途、30 万级增程 SUV",
	},
	{
		brand: "丰田", series: "赛那", modelName: "赛那 SIENNA",
		energyType: "混动", bodyType: "MPV", priceMin: 30.98, priceMax: 41.18, seats: 7,
		positioning: "商务家用 MPV", highlights: "二排独立座椅,省油可靠,空间灵活",
		scenarios: "商务接待、二胎家庭、7 座刚需用户",
	},
	{
		brand: "别克", series: "GL8", modelName: "GL8 陆尊",
		energyType: "燃油", bodyType: "MPV", priceMin: 29.99, priceMax: 45.99, seats: 7,
		positioning: "商务接待标杆", highlights: "乘坐舒适,静音好,商务气场强",
		scenarios: "商务接待、高端出行、老板座驾",
	},
];

export function seedVehicles(db: DatabaseSync, tenantIds: string[]): number {
	let count = 0;
	for (const tenantId of tenantIds) {
		for (const input of SEED_VEHICLES) {
			upsertVehicle(db, { ...input, tenantId });
			count++;
		}
	}
	return count;
}