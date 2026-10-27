import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface DigestRecord {
	id: string;
	tenantId: string;
	digestDate: string;
	title: string;
	content: string;
	statsJson: string;
	createdAt: string;
}

export function createDigest(
	db: DatabaseSync,
	input: { tenantId: string; digestDate: string; title: string; content: string; statsJson: string },
): DigestRecord {
	const id = randomUUID();
	db.prepare(
		"INSERT INTO digests (id, tenant_id, digest_date, title, content, stats_json) VALUES (?,?,?,?,?,?)",
	).run(id, input.tenantId, input.digestDate, input.title, input.content, input.statsJson);
	return db.prepare("SELECT * FROM digests WHERE id = ?").get(id) as unknown as DigestRecord;
}

export function getDigestByDate(db: DatabaseSync, tenantId: string, digestDate: string): DigestRecord | undefined {
	const row = db.prepare("SELECT * FROM digests WHERE tenant_id = ? AND digest_date = ?").get(tenantId, digestDate) as
		| Record<string, unknown>
		| undefined;
	return row ? mapRow(row) : undefined;
}

export function listDigests(db: DatabaseSync, tenantId: string, limit = 10): DigestRecord[] {
	const rows = db
		.prepare("SELECT * FROM digests WHERE tenant_id = ? ORDER BY digest_date DESC LIMIT ?")
		.all(tenantId, limit) as Record<string, unknown>[];
	return rows.map(mapRow);
}

function mapRow(row: Record<string, unknown>): DigestRecord {
	return {
		id: String(row.id),
		tenantId: String(row.tenant_id),
		digestDate: String(row.digest_date),
		title: String(row.title),
		content: String(row.content),
		statsJson: String(row.stats_json),
		createdAt: String(row.created_at),
	};
}