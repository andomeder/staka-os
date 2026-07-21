import { createApp } from "../../src/app.ts";
import type { DbPools } from "../../src/db/client.ts";
import { generateJwtKeyEntry, loadKeyring } from "../../src/lib/jwt.ts";
import {
  createActivationRateLimiters,
  type ActivationRateLimiters,
} from "../../src/lib/rate-limit.ts";
import { MachineStatusCache } from "../../src/lib/machine-status-cache.ts";

export function testJwtKeysJson(kids = ["test-key-1", "test-key-2"]): string {
  const entries = kids.map((kid) => generateJwtKeyEntry(kid));
  return JSON.stringify(entries);
}

export async function createTestApp(opts: {
  pools: DbPools;
  jwtKeysJson?: string;
  rateLimiters?: ActivationRateLimiters;
  autoApprove?: boolean;
  autoApproveActorId?: string;
}) {
  const jwtKeysJson = opts.jwtKeysJson ?? testJwtKeysJson();
  const keyring = await loadKeyring(jwtKeysJson);
  const rateLimiters = opts.rateLimiters ?? createActivationRateLimiters();
  const statusCache = new MachineStatusCache(60_000);
  const appDeps: Parameters<typeof createApp>[0] = {
    dbApp: opts.pools.app,
    keyring,
    rateLimiters,
    statusCache,
    checkDb: async () => true,
  };
  if (opts.autoApprove !== undefined) appDeps.autoApprove = opts.autoApprove;
  if (opts.autoApproveActorId !== undefined) {
    appDeps.autoApproveActorId = opts.autoApproveActorId;
  }
  const app = createApp(appDeps);
  return { app, keyring, rateLimiters, statusCache, jwtKeysJson };
}
