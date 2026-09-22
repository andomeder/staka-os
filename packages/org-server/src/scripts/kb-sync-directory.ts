import { createDb } from "../db/client.ts";
import { kbConfigFromEnv } from "../lib/kb.ts";
import { syncDirectoryProfiles } from "../lib/kb-ingest.ts";

/**
 * Re-ingest every active user's directory profile into the knowledge base.
 * Run after bulk user changes; the dashboard keeps profiles in step during
 * normal operation.
 */
async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const kb = kbConfigFromEnv({
    STAKA_KB_ENGINE_URL: process.env.STAKA_KB_ENGINE_URL,
    STAKA_KB_ENGINE_KEY: process.env.STAKA_KB_ENGINE_KEY,
    STAKA_KB_SPACE: process.env.STAKA_KB_SPACE,
  });
  if (!kb) {
    throw new Error("STAKA_KB_ENGINE_URL is required");
  }
  const db = createDb(databaseUrl);
  try {
    const count = await syncDirectoryProfiles({
      db,
      client: kb.client,
      space: kb.space,
      orgId: kb.space.slice("org_".length),
    });
    console.log(`synced ${count} directory profiles to the knowledge base`);
  } finally {
    await db.$client.end({ timeout: 2 });
  }
}

await main();
