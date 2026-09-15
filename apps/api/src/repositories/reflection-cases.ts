import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type ReflectionCaseType = "evaluation_low" | "run_failed";

export interface ReflectionCase {
	id: string;
	tenantId: string;
	caseType: ReflectionCaseType;
	refId: string | null;
	detailJson: string | null;
	createdAt: string;
}

export function createReflectionCase(
	db: DatabaseSync,
	input: { tenantId: string; caseType: ReflectionCaseType; refId?: string; detail?: unknown },
): ReflectionCase {
	const id = randomUUID();
	db.prepare(
		"INSERT INTO reflection_cases (id, tenant_id, case_type, ref_id, detail_json) VALUES (?,?,?,?,?)",
	).run(id, input.tenantId, input.caseType, input.refId ?? null, input.detail !== undefined ? JSON.stringify(input.detail) : null);
	return db.prepare("SELECT * FROM reflection_cases WHERE id = ?").get(id) as unknown as ReflectionCase;
}

export function listReflectionCases(
	db: DatabaseSync,
	tenantId: string,
	input: { caseType?: ReflectionCaseType; days?: number; limit?: number } = {},
): ReflectionCase[] {
	const clauses = ["tenant_id = ?"];
	const params: Array<string | number> = [tenantId];
	if (input.caseType) {
		clauses.push("case_type = ?");
		params.push(input.caseType);
	}
	if (input.days) {
		clauses.push("created_at >= datetime('now', ?)");
		params.push(`-${input.days} days`);
	}
	params.push(input.limit ?? 200);
	const rows = db
		.prepare(`SELECT * FROM reflection_cases WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT ?`)
		.all(...params) as Record<string, unknown>[];
	return rows.map(mapRow);
}

export function countReflectionCases(db: DatabaseSync, tenantId: string, days: number): Array<{ case_type: string; count: number }> {
	const rows = db
		.prepare(
			`SELECT case_type, COUNT(*) AS count FROM reflection_cases
			 WHERE tenant_id = ? AND created_at >= datetime('now', ?) GROUP BY case_type`,
		)
		.all(tenantId, `-${days} days`) as Array<{ case_type: string; count: number }>;
	return rows;
}

function mapRow(row: Record<string, unknown>): ReflectionCase {
	return {
		id: String(row.id),
		tenantId: String(row.tenant_id),
		caseType: String(row.case_type) as ReflectionCaseType,
		refId: row.ref_id ? String(row.ref_id) : null,
		detailJson: row.detail_json ? String(row.detail_json) : null,
		createdAt: String(row.created_at),
	};
}