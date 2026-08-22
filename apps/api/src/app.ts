import Fastify, { type FastifyInstance } from "fastify";

export interface AppOptions {
	logger?: boolean;
	prefix?: string;
}

export function buildApp(options: AppOptions = {}): FastifyInstance {
	const app = Fastify({ logger: options.logger ?? false });

	app.get("/api/v1/health", async () => ({ status: "ok", ts: Date.now() }));

	return app;
}