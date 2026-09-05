import { config } from "./env.js";
import { buildApp } from "./app.js";


const app = buildApp({ logger: true });

app
	.listen({ port: config.port, host: config.host })
	.then(() => {
		app.log.info(`sales-copilot api listening on ${config.host}:${config.port}`);
	})
	.catch((error: unknown) => {
		const detail = error instanceof Error ? error.message : String(error);
		console.error(`[server] 启动失败(${config.host}:${config.port}): ${detail}`);
		if (detail.includes("EADDRINUSE")) {
			console.error("[server] 提示:端口已被占用,请修改 help-sale.config.yaml 的 server.port 后重试");
		}
		process.exit(1);
	});