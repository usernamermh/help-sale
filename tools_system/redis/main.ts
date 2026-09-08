import { config } from "../../apps/api/src/env.js";

interface ToolContext { db: any; tenantId: string; }

const OPS = ["get", "set", "del", "keys", "ttl", "expire", "incr", "zadd", "zrange"];

export async function execute(_ctx: ToolContext, params: any) {
	const op = String(params?.op ?? "");
	if (!OPS.includes(op)) return { content: [{ type: "text", text: `不支持的操作 ${op},可选:${OPS.join("/")}` }] };
	let redis: any;
	try {
		redis = (await import("ioredis")).default;
	} catch (error) {
		return { content: [{ type: "text", text: `ioredis 不可用:${error instanceof Error ? error.message : String(error)}` }] };
	}
	const client = new redis({ host: config.redisHost, port: config.redisPort, password: config.redisPassword || undefined, connectTimeout: 3000, maxRetriesPerRequest: 0, lazyConnect: true });
	try {
		await client.connect();
		const key = String(params.key ?? "");
		let out: unknown;
		if (op === "get") out = await client.get(key);
		else if (op === "set") { out = await client.set(key, String(params.value ?? "")); if (params.expireSeconds) await client.expire(key, Number(params.expireSeconds)); }
		else if (op === "del") { const keys = Array.isArray(params.keys) ? params.keys : [key]; out = await client.del(...keys); }
		else if (op === "keys") out = await client.keys(String(params.pattern ?? "*"));
		else if (op === "ttl") out = await client.ttl(key);
		else if (op === "expire") out = await client.expire(key, Number(params.expireSeconds ?? 0));
		else if (op === "incr") out = await client.incr(key);
		else if (op === "zadd") out = await client.zadd(key, Number(params.score ?? 0), String(params.member ?? ""));
		else if (op === "zrange") out = await client.zrange(key, Number(params.start ?? 0), Number(params.stop ?? -1));
		const text = typeof out === "string" ? out : JSON.stringify(out ?? null);
		return { content: [{ type: "text", text: `redis ${op} ${key || ""} => ${text}` }], details: { op, key, result: out } };
	} catch (error) {
		return { content: [{ type: "text", text: `redis 操作失败:${error instanceof Error ? error.message : String(error)}` }] };
	} finally {
		client.disconnect();
	}
}