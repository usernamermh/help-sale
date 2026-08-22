import { loadConfig, loadEnv } from "./env.js";
import { buildApp } from "./app.js";

loadEnv();

const config = loadConfig();
const app = buildApp({ logger: true });

app.listen({ port: config.port, host: config.host }).then(() => {
	app.log.info(`sales-copilot api listening on ${config.host}:${config.port}`);
});