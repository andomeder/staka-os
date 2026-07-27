import { createApp } from "./app.ts";
import { checkDb } from "./db/client.ts";
import { loadEnv } from "./env.ts";
import { createLogger } from "./lib/logger.ts";

const env = loadEnv(process.env, {
  requireSecrets: process.env.NODE_ENV === "production",
});
const log = createLogger(env.LOG_LEVEL);

const app = createApp({
  logger: log,
  checkDb: env.DATABASE_URL
    ? () => checkDb(env.DATABASE_URL)
    : undefined,
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
