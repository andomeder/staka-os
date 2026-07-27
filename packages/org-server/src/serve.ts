import { eq } from "drizzle-orm";
import { createApp } from "./app.ts";
import { checkDb, createDbPools } from "./db/client.ts";
import { users } from "./db/schema.ts";
import { loadEnv } from "./env.ts";
import { AdminFlashStore } from "./lib/admin-flash.ts";
import { AdminSessionStore } from "./lib/admin-session.ts";
import { createCsrfSigner, csrfSecretFromJwtKeys } from "./lib/csrf.ts";
import { loadKeyring } from "./lib/jwt.ts";
import { createLogger } from "./lib/logger.ts";
import { createActivationRateLimiters } from "./lib/rate-limit.ts";

export async function serve(
  envRaw: Record<string, string | undefined> = process.env,
): Promise<{ app: ReturnType<typeof createApp>; server: ReturnType<typeof Bun.serve> }> {
  const env = loadEnv(envRaw, {
    requireSecrets:
      envRaw.NODE_ENV === "production" ||
      envRaw.STAKA_REQUIRE_SECRETS === "1",
  });
  const log = createLogger(env.LOG_LEVEL);

  const hasDb = env.DATABASE_URL.length > 0;
  const hasJwt = env.STAKA_JWT_KEYS.length > 0;

  if (
    (env.NODE_ENV === "production" || envRaw.STAKA_REQUIRE_SECRETS === "1") &&
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
  const sessions = new AdminSessionStore();
  const flashes = new AdminFlashStore();
  const csrf = hasJwt
    ? createCsrfSigner(csrfSecretFromJwtKeys(env.STAKA_JWT_KEYS))
    : undefined;

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
    secureCookies: env.NODE_ENV === "production",
    sessions,
    flashes,
  };
  if (autoApproveActorId) appDeps.autoApproveActorId = autoApproveActorId;
  if (hasDb) {
    appDeps.checkDb = () => checkDb(env.DATABASE_APP_URL || env.DATABASE_URL);
  }
  if (pools) {
    appDeps.dbApp = pools.app;
    appDeps.dbAdmin = pools.admin;
  }
  if (keyring) appDeps.keyring = keyring;
  if (csrf) appDeps.csrf = csrf;
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
      admin: Boolean(pools && keyring && sessions && csrf),
      auto_approve: env.STAKA_AUTO_APPROVE,
      trust_proxy: env.TRUST_PROXY,
    },
    "staka-org-server listening",
  );

  return { app, server };
}
