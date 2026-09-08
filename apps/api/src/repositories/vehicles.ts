import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface VehicleRow {
	id: string;
	tenantId: string;
	brand: string;
	series: string;
	modelName: string;
	energyType: string;
	bodyType: string;
	priceMin: number;
	priceMax: number;
	seats: number;
	positioning: string | null;
	highlights: string | null;
	scenarios: string | null;
	specsJson: string;
}

export interface VehicleInput {
	tenantId: string;
	brand: string;
	series: string;
	modelName: string;
	energyType: string; // 燃油/纯电/混动
	bodyType: string; // 轿车/SUV/MPV
	priceMin: number; // 指导价下限(万元)
	priceMax: number;
	seats: number;
	positioning?: string;
	highlights?: string;
	scenarios?: string;
	specs?: Record<string, unknown>;
}

export interface VehicleSearchQuery {
	tenantId: string;
	budgetMin?: number;
	budgetMax?: number;
	seats?: number;
	energyType?: string;
	bodyType?: string;
	keyword?: string;
	limit?: number;
}

export function upsertVehicle(db: DatabaseSync, input: VehicleInput): VehicleRow {
	const existing = db
		.prepare("SELECT id FROM vehicles WHERE tenant_id = ? AND brand = ? AND series = ? AND model_name = ?")
		.get(input.tenantId, input.brand, input.series, input.modelName) as { id: string } | undefined;

	const specs = JSON.stringify(input.specs ?? {});
	if (existing) {
		db.prepare(
			`UPDATE vehicles
			 SET energy_type = ?, body_type = ?, price_min = ?, price_max = ?, seats = ?,
			     positioning = ?, highlights = ?, scenarios = ?, specs_json = ?
			 WHERE id = ?`,
		).run(
			input.energyType,
			input.bodyType,
			input.priceMin,
			input.priceMax,
			input.seats,
			input.positioning ?? null,
			input.highlights ?? null,
			input.scenarios ?? null,
			specs,
			existing.id,
		);
		return mapRow(db.prepare("SELECT * FROM vehicles WHERE id = ?").get(existing.id) as Record<string, unknown>);
	}

	const id = randomUUID();
	db.prepare(
		`INSERT INTO vehicles
		 (id, tenant_id, brand, series, model_name, energy_type, body_type, price_min, price_max, seats, positioning, highlights, scenarios, specs_json)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
	).run(
		id,
		input.tenantId,
		input.brand,
		input.series,
		input.modelName,
		input.energyType,
		input.bodyType,
		input.priceMin,
		input.priceMax,
		input.seats,
		input.positioning ?? null,
		input.highlights ?? null,
		input.scenarios ?? null,
		specs,
	);
	return mapRow(db.prepare("SELECT * FROM vehicles WHERE id = ?").get(id) as Record<string, unknown>);
}

export function listVehicles(db: DatabaseSync, tenantId: string, limit = 200): VehicleRow[] {
	const rows = db
		.prepare("SELECT * FROM vehicles WHERE tenant_id = ? ORDER BY price_min ASC LIMIT ?")
		.all(tenantId, limit) as Record<string, unknown>[];
	return rows.map(mapRow);
}

export function searchVehicles(db: DatabaseSync, query: VehicleSearchQuery): VehicleRow[] {
	const clauses: string[] = ["tenant_id = ?"];
	const params: (string | number)[] = [query.tenantId];
	if (query.budgetMin !== undefined) {
		clauses.push("price_max >= ?");
		params.push(query.budgetMin);
	}
	if (query.budgetMax !== undefined) {
		clauses.push("price_min <= ?");
		params.push(query.budgetMax);
	}
	if (query.seats !== undefined) {
		clauses.push("seats = ?");
		params.push(query.seats);
	}
	if (query.energyType) {
		clauses.push("energy_type = ?");
		params.push(query.energyType);
	}
	if (query.bodyType) {
		clauses.push("body_type = ?");
		params.push(query.bodyType);
	}
	let limit = Math.min(query.limit ?? 10, 50);
	let sql = `SELECT * FROM vehicles WHERE ${clauses.join(" AND ")}`;
	if (query.keyword) {
		sql =
			`SELECT v.* FROM vehicles v
			 WHERE tenant_id = ? AND (brand LIKE ? OR series LIKE ? OR model_name LIKE ? OR highlights LIKE ? OR scenarios LIKE ?)`;
		params.length = 0;
		const kw = `%${query.keyword}%`;
		params.push(query.tenantId, kw, kw, kw, kw, kw);
		limit = Math.min(query.limit ?? 10, 50);
	}
	sql += " ORDER BY price_min ASC LIMIT ?";
	params.push(limit);
	const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
	return rows.map(mapRow);
}

function mapRow(row: Record<string, unknown>): VehicleRow {
	return {
		id: String(row.id),
		tenantId: String(row.tenant_id),
		brand: String(row.brand),
		series: String(row.series),
		modelName: String(row.model_name),
		energyType: String(row.energy_type),
		bodyType: String(row.body_type),
		priceMin: Number(row.price_min),
		priceMax: Number(row.price_max),
		seats: Number(row.seats),
		positioning: row.positioning ? String(row.positioning) : null,
		highlights: row.highlights ? String(row.highlights) : null,
		scenarios: row.scenarios ? String(row.scenarios) : null,
		specsJson: String(row.specs_json),
	};
}