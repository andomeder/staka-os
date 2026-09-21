import { createApp } from "../../src/app.ts";
import type { DbPools } from "../../src/db/client.ts";
import { AdminFlashStore } from "../../src/lib/admin-flash.ts";
import { AdminSessionStore } from "../../src/lib/admin-session.ts";
import {
  createCsrfSigner,
  csrfSecretFromJwtKeys,
} from "../../src/lib/csrf.ts";
import { generateJwtKeyEntry, loadKeyring } from "../../src/lib/jwt.ts";
import { MachineStatusCache } from "../../src/lib/machine-status-cache.ts";
import {
  createActivationRateLimiters,
  type ActivationRateLimiters,
} from "../../src/lib/rate-limit.ts";

export function testJwtKeysJson(kids = ["test-key-1", "test-key-2"]): string {
  const entries = kids.map((kid) => generateJwtKeyEntry(kid));
  return JSON.stringify(entries);
}

export async function createTestApp(opts: {
  pools: DbPools;
  jwtKeysJson?: string;
  rateLimiters?: ActivationRateLimiters;
  sessions?: AdminSessionStore;
  flashes?: AdminFlashStore;
  autoApprove?: boolean;
  autoApproveActorId?: string;
  trustProxy?: boolean;
  secureCookies?: boolean;
  logger?: { info: (obj: unknown, msg?: string) => void; error: (obj: unknown, msg?: string) => void };
}) {
  const jwtKeysJson = opts.jwtKeysJson ?? testJwtKeysJson();
  const keyring = await loadKeyring(jwtKeysJson);
  const rateLimiters = opts.rateLimiters ?? createActivationRateLimiters();
  const statusCache = new MachineStatusCache(60_000);
  const sessions = opts.sessions ?? new AdminSessionStore();
  const flashes = opts.flashes ?? new AdminFlashStore();
  const csrf = createCsrfSigner(csrfSecretFromJwtKeys(jwtKeysJson));
  const appDeps: Parameters<typeof createApp>[0] = {
    dbApp: opts.pools.app,
    dbAdmin: opts.pools.admin,
    keyring,
    rateLimiters,
    statusCache,
    sessions,
    flashes,
    csrf,
    checkDb: async () => true,
    secureCookies: opts.secureCookies ?? false,
  };
  if (opts.autoApprove !== undefined) appDeps.autoApprove = opts.autoApprove;
  if (opts.autoApproveActorId !== undefined) {
    appDeps.autoApproveActorId = opts.autoApproveActorId;
  }
  if (opts.trustProxy !== undefined) appDeps.trustProxy = opts.trustProxy;
  if (opts.logger) appDeps.logger = opts.logger;
  const app = createApp(appDeps);
  return {
    app,
    keyring,
    rateLimiters,
    statusCache,
    sessions,
    flashes,
    csrf,
    jwtKeysJson,
  };
}
