import { createApp } from "./app.ts";
import { loadEnv } from "./env.ts";
import { createLogger } from "./lib/logger.ts";

const env = loadEnv(process.env, { requireSecrets: false });
const log = createLogger(env.LOG_LEVEL);

const app = createApp({
  logger: log,
  checkDb: undefined,
});

const server = Bun.serve({
  hostname: env.HOST,
  port: env.PORT,
  fetch: app.fetch,
});

log.info(
  { host: server.hostname, port: server.port, env: env.NODE_ENV },
  "staka-org-server listening",
);

export { app, server };
