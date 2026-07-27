import { eq } from "drizzle-orm";
import { createApp } from "./app.ts";
import { checkDb, createDbPools } from "./db/client.ts";
import { users } from "./db/schema.ts";
import { loadEnv } from "./env.ts";
import { loadKeyring } from "./lib/jwt.ts";
import { createLogger } from "./lib/logger.ts";
import { createActivationRateLimiters } from "./lib/rate-limit.ts";

const env = loadEnv(process.env, {
  requireSecrets:
    process.env.NODE_ENV === "production" ||
    process.env.STAKA_REQUIRE_SECRETS === "1",
});
const log = createLogger(env.LOG_LEVEL);

const hasDb = env.DATABASE_URL.length > 0;
const hasJwt = env.STAKA_JWT_KEYS.length > 0;

if (
  (env.NODE_ENV === "production" || process.env.STAKA_REQUIRE_SECRETS === "1") &&
  (!hasDb || !hasJwt)
) {
  throw new Error("DATABASE_URL and STAKA_JWT_KEYS are required");
}

const pools = hasDb
  ? createDbPools({
      owner: env.DATABASE_URL,
      app: env.DATABASE_APP_URL,
      admin: env.DATABASE_ADMIN_URL,
    })
  : undefined;

const keyring = hasJwt ? await loadKeyring(env.STAKA_JWT_KEYS) : undefined;

let autoApproveActorId = env.STAKA_AUTO_APPROVE_ACTOR_ID;
if (env.STAKA_AUTO_APPROVE) {
  if (!autoApproveActorId && pools) {
    const [admin] = await pools.owner
      .select({ id: users.id })
      .from(users)
      .where(eq(users.employeeId, env.STAKA_SEED_ADMIN_EMPLOYEE_ID))
      .limit(1);
    autoApproveActorId = admin?.id;
  }
  if (!autoApproveActorId) {
    throw new Error(
      "STAKA_AUTO_APPROVE requires STAKA_AUTO_APPROVE_ACTOR_ID or a seeded admin matching STAKA_SEED_ADMIN_EMPLOYEE_ID",
    );
  }
}

const appDeps: Parameters<typeof createApp>[0] = {
  logger: log,
  autoApprove: env.STAKA_AUTO_APPROVE,
  trustProxy: env.TRUST_PROXY,
};
if (autoApproveActorId) appDeps.autoApproveActorId = autoApproveActorId;
if (hasDb) {
  appDeps.checkDb = () => checkDb(env.DATABASE_APP_URL || env.DATABASE_URL);
}
if (pools) appDeps.dbApp = pools.app;
if (keyring) appDeps.keyring = keyring;
if (keyring && pools) {
  appDeps.rateLimiters = createActivationRateLimiters();
}
const app = createApp(appDeps);

const server = Bun.serve({
  hostname: env.HOST,
  port: env.PORT,
  fetch: app.fetch,
});

log.info(
  {
    host: server.hostname,
    port: server.port,
    env: env.NODE_ENV,
    activation: Boolean(pools && keyring),
    auto_approve: env.STAKA_AUTO_APPROVE,
    trust_proxy: env.TRUST_PROXY,
  },
  "staka-org-server listening",
);

export { app, server };
