import type { DatabaseSync } from "node:sqlite";
import { upsertVehicle, type VehicleInput } from "../repositories/vehicles.js";
import { createDeal, upsertSalesperson, upsertStore } from "../repositories/store-ops.js";
import { upsertCustomer } from "../repositories/customers.js";
import { replaceConversationMessages } from "../repositories/conversation-data.js";

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

// ── 门店管理示例数据:门店/店长/销售/客户/会话原文/成交 ──
export interface DemoSalesSpec { name: string; phone: string; }
export interface DemoStoreSpec {
	name: string;
	address: string;
	managerName: string;
	managerPhone: string;
	sales: DemoSalesSpec[];
}

export const SEED_STORES: DemoStoreSpec[] = [
	{
		name: "苏州旗舰店",
		address: "苏州市工业园区星湖街 328 号",
		managerName: "张店长",
		managerPhone: "13800000001",
		sales: [
			{ name: "李销售", phone: "13900000001" },
			{ name: "王销售", phone: "13900000002" },
		],
	},
	{
		name: "上海闵行店",
		address: "上海市闵行区吴中路 1588 号",
		managerName: "刘店长",
		managerPhone: "13800000002",
		sales: [
			{ name: "赵销售", phone: "13900000003" },
			{ name: "孙销售", phone: "13900000004" },
		],
	},
];

function daysAgoIso(days: number, hourOffset = 9): string {
	return new Date(Date.now() - days * 24 * 3600 * 1000 + hourOffset * 3600 * 1000).toISOString();
}

/** 门店台账 + 门店经营演示数据(客户/会话原文/成交),全部固定 id 幂等。 */
export function seedStoreData(db: DatabaseSync, tenantIds: string[]): number {
	let count = 0;
	for (const tenantId of tenantIds) {
		for (const [si, spec] of SEED_STORES.entries()) {
			const store = upsertStore(db, tenantId, { name: spec.name, address: spec.address });
			upsertSalesperson(db, tenantId, { storeId: store.id, name: spec.managerName, phone: spec.managerPhone, role: "manager" });
			for (const s of spec.sales) {
				upsertSalesperson(db, tenantId, { storeId: store.id, name: s.name, phone: s.phone });
			}
			count += 1 + spec.sales.length + 1; // 门店 + 销售 + 店长

			// 3 位演示客户 + 4 段原文会话(近 12 天) + 3 笔成交(近 15 天)
			for (let c = 0; c < 3; c++) {
				upsertCustomer(db, {
					tenantId,
					key: `c_demo_${si}_${c}`,
					name: `演示客户${si + 1}-${c + 1}`,
					company: "智造科技",
					stage: c === 2 ? "成交" : "洽谈中",
					phone: `1360000000${si * 3 + c + 1}`,
				});
			}
			for (let i = 0; i < 4; i++) {
				const convId = `seed-conv-${tenantId}-${si}-${i}`;
				const day = i * 3;
				db.prepare(
					`INSERT OR IGNORE INTO conversations (id, tenant_id, customer_id, sales_name, sales_id, sales_phone, store_id, followup_advice, channel, message_count, created_at, updated_at)
					 VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
				).run(
					convId, tenantId,
					(customerRow(db, tenantId, `c_demo_${si}_${i % 3}`))!.id,
					spec.sales[i % 2].name,
					(salesRow(db, tenantId, store.id, spec.sales[i % 2].name))!.id,
					spec.sales[i % 2].phone,
					store.id,
					i === 2 ? "跟进:发送配置单并预约二次试驾" : null,
					"chat", 4, daysAgoIso(day), daysAgoIso(day),
				);
				replaceConversationMessages(db, tenantId, convId, [
					{ speakerRole: "customer", speakerName: `演示客户${si + 1}-${i % 3 + 1}`, content: `你好,想了解一下${si === 0 ? "汉EV 的优惠方案" : "Model Y 的现车情况"}。`, spokenAt: daysAgoIso(day, 9) },
					{ speakerRole: "sales", speakerName: spec.sales[i % 2].name, content: "您好,很高兴为您服务。您平时主要通勤还是商务使用?", spokenAt: daysAgoIso(day, 9) },
					{ speakerRole: "customer", speakerName: `演示客户${si + 1}-${i % 3 + 1}`, content: "主要是家庭用车,偶尔接送客户,预算 20-30 万。", spokenAt: daysAgoIso(day, 9) },
					{ speakerRole: "sales", speakerName: spec.sales[i % 2].name, content: "明白了,我建议先看汉EV 冠军版,和您的需求非常匹配,这几天有试驾活动。", spokenAt: daysAgoIso(day, 9) },
				]);
			}
			for (let d = 0; d < 3; d++) {
				createDeal(db, tenantId, {
					id: `seed-deal-${tenantId}-${si}-${d}`,
					storeId: store.id,
					salesId: (salesRow(db, tenantId, store.id, spec.sales[d % 2].name))!.id,
					customerId: (customerRow(db, tenantId, `c_demo_${si}_${d % 3}`))!.id,
					amount: [199900, 249900, 299900][d],
					dealedAt: daysAgoIso(d * 5, 15),
				});
			}
		}
	}
	return count;
}

function customerRow(db: DatabaseSync, tenantId: string, key: string): { id: string } | undefined {
	return db.prepare("SELECT id FROM customers WHERE tenant_id = ? AND key = ?").get(tenantId, key) as unknown as { id: string } | undefined;
}
function salesRow(db: DatabaseSync, tenantId: string, storeId: string, name: string): { id: string } | undefined {
	return db.prepare("SELECT id FROM sales WHERE tenant_id = ? AND store_id = ? AND name = ?").get(tenantId, storeId, name) as unknown as { id: string } | undefined;
}