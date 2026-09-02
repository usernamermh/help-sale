import mysql from "mysql2/promise";

export interface MysqlConfig {
	enabled: boolean;
	host: string;
	port: number;
	user: string;
	password: string;
	database: string;
}

export interface AnalysisSinkRecord {
	id: string;
	tenantId: string;
	customerId: string;
	conversationId: string;
	intent: string;
	summary: string;
	signalsJson?: string;
	suggestedReply?: string;
	nextStepsJson?: string;
	followupAt?: string;
	createdAt: string;
}

export interface VehiclePlanSinkRecord {
	id: string;
	tenantId: string;
	customerId: string;
	conversationId: string;
	requirement: string;
	planJson: string;
	createdAt: string;
}

function mysqlDatetime(iso: string): string {
	try {
		return new Date(iso).toISOString().slice(0, 23).replace("T", " ");
	} catch {
		return iso;
	}
}

export interface MysqlSink {
	appendAnalysis(record: AnalysisSinkRecord): Promise<void>;
	appendVehiclePlan(record: VehiclePlanSinkRecord): Promise<void>;
	close(): Promise<void>;
}

/** mysql2 默认不支持多语句,因此逐条执行。 */
const DDL_STATEMENTS: string[] = [
	`CREATE TABLE IF NOT EXISTS analyses (
	  id VARCHAR(64) PRIMARY KEY,
	  tenant_id VARCHAR(64) NOT NULL,
	  customer_id VARCHAR(64) NOT NULL,
	  conversation_id VARCHAR(64) NOT NULL,
	  intent VARCHAR(255) NOT NULL,
	  summary TEXT NOT NULL,
	  signals_json JSON,
	  suggested_reply LONGTEXT,
	  next_steps_json JSON,
	  followup_at VARCHAR(64),
	  created_at DATETIME(3) NOT NULL,
	  KEY idx_an_tenant (tenant_id, customer_id, created_at)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
	`CREATE TABLE IF NOT EXISTS vehicle_match_plans (
	  id VARCHAR(64) PRIMARY KEY,
	  tenant_id VARCHAR(64) NOT NULL,
	  customer_id VARCHAR(64) NOT NULL,
	  conversation_id VARCHAR(64) NOT NULL,
	  requirement JSON,
	  plan_json JSON,
	  created_at DATETIME(3) NOT NULL,
	  KEY idx_vp_tenant (tenant_id, customer_id, created_at)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

/** 追加写入的归档 sink:失败只降级跳过,绝不阻断主流程。 */
export function createMysqlSink(config: MysqlConfig): MysqlSink {
	if (!config.enabled) return createNoopSink("mysql disabled");
	let pool: mysql.Pool | undefined;
	let ready: Promise<mysql.Pool> | undefined;

	async function ensure(): Promise<mysql.Pool> {
		if (ready) return ready;
		ready = (async () => {
			const p = mysql.createPool({
				host: config.host,
				port: config.port,
				user: config.user,
				password: config.password,
				database: config.database,
				connectionLimit: 4,
				connectTimeout: 4000,
				enableKeepAlive: true,
			});
			const conn = await p.getConnection();
			try {
				for (const statement of DDL_STATEMENTS) {
					await conn.query(statement);
				}
			} finally {
				conn.release();
			}
			pool = p;
			console.log("[mysql-sink] 归档仓库已连接并初始化");
			return p;
		})().catch((error: unknown) => {
			ready = undefined;
			const detail = error instanceof Error ? error.message : String(error);
			console.warn(`[mysql-sink] 不可用,归档降级跳过: ${detail}`);
			pool?.end().catch(() => undefined);
			pool = undefined;
			throw error;
		});
		return ready;
	}

	async function withPool<T>(fn: (p: mysql.Pool) => Promise<T>): Promise<void> {
		try {
			const p = await ensure();
			await fn(p);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			console.warn(`[mysql-sink] 写入降级跳过: ${detail}`);
		}
	}

	return {
		async appendAnalysis(record) {
			if (!config.enabled) return;
			await withPool((p) =>
				p.execute(
					`INSERT INTO analyses
					 (id, tenant_id, customer_id, conversation_id, intent, summary, signals_json, suggested_reply, next_steps_json, followup_at, created_at)
					 VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
					[
						record.id,
						record.tenantId,
						record.customerId,
						record.conversationId,
						record.intent,
						record.summary,
						record.signalsJson ?? null,
						record.suggestedReply ?? null,
						record.nextStepsJson ?? null,
						record.followupAt ?? null,
						mysqlDatetime(record.createdAt),
					],
				),
			);
		},
		async appendVehiclePlan(record) {
			if (!config.enabled) return;
			await withPool((p) =>
				p.execute(
					`INSERT INTO vehicle_match_plans
					 (id, tenant_id, customer_id, conversation_id, requirement, plan_json, created_at)
					 VALUES (?,?,?,?,?,?,?)`,
					[record.id, record.tenantId, record.customerId, record.conversationId, record.requirement, record.planJson, mysqlDatetime(record.createdAt)],
				),
			);
		},
		async close() {
			if (pool) {
				await pool.end().catch(() => undefined);
				pool = undefined;
			}
		},
	};
}

function createNoopSink(reason: string): MysqlSink {
	return {
		appendAnalysis: async () => undefined,
		appendVehiclePlan: async () => undefined,
		close: async () => undefined,
		...(reason ? { _reason: reason } : {}),
	} as MysqlSink;
}