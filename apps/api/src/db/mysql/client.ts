import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { translateSql } from "./translate.js";
import { config } from "../../env.js";

/**
 * MySQL 主库同步桥(current data.mode=mysql 专用):
 * 提供与 node:sqlite DatabaseSync 兼容的 prepare/exec 同步接口,
 * 底层通过 worker_threads + SharedArrayBuffer 阻塞等待 MySQL 执行结果,
 * 仓库层无需任何改动即可读写远程库。SQL 方言在调用时经 translateSql 转换。
 */
export interface SyncMysqlStatement {
	run(...params: unknown[]): { changes: number; lastInsertRowid?: unknown };
	get(...params: unknown[]): Record<string, unknown> | undefined;
	all(...params: unknown[]): Array<Record<string, unknown>>;
}

interface MysqlCallResult {
	status: "ok" | "error";
	rows?: Array<Record<string, unknown>>;
	changes?: number;
	message?: string;
}

const RESULT_BUF_BYTES = 16 * 1024 * 1024; // 16MB(单次查询结果上限)

export class SyncMysqlDb {
	private worker: Worker;
	private resultBuf: SharedArrayBuffer;
	private resultView: Int32Array;
	private timeoutMs: number;
	private closed = false;

	constructor(opts: {
		host: string;
		port: number;
		user: string;
		password: string;
		database: string;
		schemaSql?: string;
		forceRebuild?: boolean;
		timeoutMs?: number;
	}) {
		this.timeoutMs = opts.timeoutMs ?? config.mysqlConnectTimeout;
		this.resultBuf = new SharedArrayBuffer(RESULT_BUF_BYTES);
		this.resultView = new Int32Array(this.resultBuf);
		this.worker = new Worker(new URL("./worker.js", import.meta.url), { workerData: {} });
		this.worker.on("error", () => {
			// worker 异常:把 pending 请求标记失败,否则主线程可能无限等待
			if (Atomics.load(this.resultView, 0) === 0) {
				const dv = new DataView(this.resultBuf);
				const msg = Buffer.from(JSON.stringify({ status: "error", message: "mysql worker 进程异常退出" }), "utf8");
				if (msg.length <= this.resultBuf.byteLength - 8) {
					dv.setUint32(4, msg.length, true);
					new Uint8Array(this.resultBuf, 8, msg.length).set(msg);
					Atomics.store(this.resultView, 0, 1);
					Atomics.notify(this.resultView, 0);
				}
			}
		});
		const init: Record<string, unknown> = {
			kind: "init",
			host: opts.host,
			port: opts.port,
			user: opts.user,
			password: opts.password,
			database: opts.database,
			resultBuf: this.resultBuf,
			schemaSql: opts.schemaSql,
			forceRebuild: opts.forceRebuild === true,
		};
		this.worker.postMessage(init);
		this.ensureReady();
	}

	private ensureReady(): void {
		if (!this.waitResult()) {
			this.worker.terminate().catch(() => undefined);
			throw new Error("mysql worker 初始化超时");
		}
		const res = this.readResult();
		if (res.status === "error") {
			this.worker.terminate().catch(() => undefined);
			throw new Error(`mysql 初始化失败: ${res.message}`);
		}
	}

	private waitResult(): boolean {
		const deadline = Date.now() + this.timeoutMs;
		while (Atomics.load(this.resultView, 0) === 0) {
			const left = deadline - Date.now();
			if (left <= 0) return false;
			Atomics.wait(this.resultView, 0, 0, Math.min(left, 50));
		}
		return true;
	}

	private readResult(): MysqlCallResult {
		this.resetReady();
		const dv = new DataView(this.resultBuf);
		const length = dv.getUint32(4, true);
		if (length <= 0 || length > this.resultBuf.byteLength - 8) {
			return { status: "error", message: "结果缓冲区无效" };
		}
		const bytes = Buffer.from(new Uint8Array(this.resultBuf, 8, length));
		try {
			return JSON.parse(bytes.toString("utf8")) as MysqlCallResult;
		} catch {
			return { status: "error", message: "结果 JSON 解析失败" };
		}
	}

	private resetReady(): void {
		Atomics.store(this.resultView, 0, 0);
	}

	private call(sql: string, stmtKind: "run" | "get" | "all", params: unknown[]): MysqlCallResult {
		if (this.closed) throw new Error("mysql 连接已关闭");
		const { sql: translated, params: translatedParams } = translateSql(sql, params);
		this.resetReady();
		this.worker.postMessage({ kind: "run", sql: translated, params: translatedParams, stmtKind });
		if (!this.waitResult()) {
			throw new Error("mysql 执行超时");
		}
		const res = this.readResult();
		if (res.status === "error") {
			throw new Error(`mysql 执行失败: ${res.message}`);
		}
		return res;
	}

	/** 兼容 DatabaseSync.prepare */
	prepare(sql: string): SyncMysqlStatement {
		return {
			run: (...params: unknown[]) => {
				const r = this.call(sql, "run", params);
				return { changes: r.changes ?? 0 };
			},
			get: (...params: unknown[]) => {
				const r = this.call(sql, "get", params);
				return (r.rows ?? [])[0];
			},
			all: (...params: unknown[]) => {
				const r = this.call(sql, "all", params);
				return r.rows ?? [];
			},
		};
	}

	/** 兼容 DatabaseSync.exec(无参数 DDL/事务等) */
	exec(sql: string): void {
		this.call(sql, "run", []);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		try {
			this.worker.postMessage({ kind: "close" });
		} catch {
			// 忽略
		}
		void this.worker.terminate().catch(() => undefined);
	}
}

/**
 * 创建 MySQL 业务库实例:按 data.mode=mysql 读取 config.mysql.*,若表未建则执行 schema.sql 建表。
 */
export function createSyncMysqlDb(): SyncMysqlDb {
	const schemaSql = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "schema.sql"), "utf8");
	return new SyncMysqlDb({
		host: config.mysqlHost,
		port: config.mysqlPort,
		user: config.mysqlUser,
		password: config.mysqlPassword,
		database: config.mysqlDatabase,
		schemaSql,
		forceRebuild: config.mysqlSchemaRebuild,
	});
}