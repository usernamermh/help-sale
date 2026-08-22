import { loadEnv } from "./env.js";
import { buildApp } from "./app.js";

loadEnv();

const port = Number(process.env.PORT ?? 3000);
const app = buildApp({ logger: true });

app.listen({ port, host: "0.0.0.0" }).then(() => {
	app.log.info(`sales-copilot api listening on :${port}`);
});