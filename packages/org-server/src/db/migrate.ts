import { existsSync } from "node:fs";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "./client.ts";

const DEFAULT_IMAGE_MIGRATIONS = "/app/db/migrations";

export function resolveMigrationsDir(
  env: Record<string, string | undefined> = process.env,
): string {
  if (env.STAKA_MIGRATIONS_DIR) return env.STAKA_MIGRATIONS_DIR;
  if (existsSync(DEFAULT_IMAGE_MIGRATIONS)) return DEFAULT_IMAGE_MIGRATIONS;
  return new URL("../../db/migrations", import.meta.url).pathname;
}

export async function runMigrate(opts?: {
  databaseUrl?: string;
  migrationsDir?: string;
}): Promise<void> {
  const databaseUrl = opts?.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  const migrationsFolder =
    opts?.migrationsDir ??
    resolveMigrationsDir({
      STAKA_MIGRATIONS_DIR: process.env.STAKA_MIGRATIONS_DIR,
    });
  if (!existsSync(migrationsFolder)) {
    throw new Error(`migrations directory not found: ${migrationsFolder}`);
  }
  const db = createDb(databaseUrl);
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await db.$client.end({ timeout: 2 });
  }
  console.log("migrations applied");
}

if (import.meta.main) {
  runMigrate().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
