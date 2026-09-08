import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../db/database.js";
import { requireTenant } from "./customers.js";
import { listVehicles, searchVehicles, upsertVehicle, type VehicleInput } from "./vehicles.js";
import { seedVehicles } from "../services/seed.js";

let db: DatabaseSync;

beforeEach(() => {
	db = openDatabase(":memory:");
	requireTenant(db, "t1", "演示租户");
});

afterEach(() => db.close());

const demo: VehicleInput = {
	tenantId: "t1",
	brand: "比亚迪",
	series: "汉",
	modelName: "汉EV 冠军版",
	energyType: "纯电",
	bodyType: "轿车",
	priceMin: 19.98,
	priceMax: 25.98,
	seats: 5,
	positioning: "商务舒适",
	highlights: "长续航,智能座舱,做工扎实",
	scenarios: "商务出行,家用通勤",
};

const demoMini: VehicleInput = {
	tenantId: "t1",
	brand: "五菱",
	series: "宏光MINI",
	modelName: "宏光MINI EV",
	energyType: "纯电",
	bodyType: "微型车",
	priceMin: 3.28,
	priceMax: 6.28,
	seats: 4,
	positioning: "代步",
	highlights: "小巧好停,用车成本低",
	scenarios: "城市代步,买菜接送",
};

describe("vehicles", () => {
	it("upsert 新增并按唯一键幂等更新", () => {
		const first = upsertVehicle(db, demo);
		expect(first.id).toBeTruthy();
		const again = upsertVehicle(db, { ...demo, priceMax: 26.98 });
		expect(again.priceMax).toBe(26.98);
		expect(listVehicles(db, "t1")).toHaveLength(1);
	});

	it("预算区间筛选(价格区间重叠)", () => {
		upsertVehicle(db, demo);
		upsertVehicle(db, demoMini);
		const hits = searchVehicles(db, { tenantId: "t1", budgetMin: 15, budgetMax: 26 });
		expect(hits).toHaveLength(1);
		expect(hits[0].series).toBe("汉");
		const cheap = searchVehicles(db, { tenantId: "t1", budgetMin: 3, budgetMax: 8 });
		expect(cheap[0].series).toBe("宏光MINI");
	});

	it("座位与能源类型筛选", () => {
		upsertVehicle(db, demo);
		upsertVehicle(db, demoMini);
		expect(searchVehicles(db, { tenantId: "t1", seats: 4 })).toHaveLength(1);
		expect(searchVehicles(db, { tenantId: "t1", energyType: "混动" })).toHaveLength(0);
	});

	it("关键词检索主打卖点", () => {
		upsertVehicle(db, demo);
		const hits = searchVehicles(db, { tenantId: "t1", keyword: "长续航" });
		expect(hits).toHaveLength(1);
		expect(hits[0].brand).toBe("比亚迪");
	});

	it("跨租户隔离", () => {
		requireTenant(db, "t2", "另一租户");
		upsertVehicle(db, demo);
		expect(listVehicles(db, "t2")).toHaveLength(0);
	});
});

describe("seedVehicles", () => {
	it("播种示例车型且幂等", () => {
		const first = seedVehicles(db, ["t1"]);
		expect(first).toBe(8);
		seedVehicles(db, ["t1"]);
		expect(listVehicles(db, "t1")).toHaveLength(8);
	});
});