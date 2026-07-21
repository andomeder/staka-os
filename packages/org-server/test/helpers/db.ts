import { execSync } from "node:child_process";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "../../src/db/client.ts";

export function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url && url.length > 0) return url;

  try {
    const port = execSync(
      "docker compose -f test/docker/docker-compose.yml port postgres 5432",
      {
        cwd: new URL("../../../../", import.meta.url).pathname,
        encoding: "utf8",
      },
    )
      .trim()
      .split(":")
      .pop();
    if (port) {
      return `postgres://staka_test@127.0.0.1:${port}/staka_test`;
    }
  } catch {
    // fall through
  }

  throw new Error(
    "DATABASE_URL is required for integration tests. Start test/docker Postgres first.",
  );
}

export async function setupTestDb() {
  const databaseUrl = requireDatabaseUrl();
  const db = createDb(databaseUrl);
  await migrate(db, {
    migrationsFolder: new URL("../../db/migrations", import.meta.url).pathname,
  });
  return { db, databaseUrl };
}

export function roleUrl(databaseUrl: string, role: "staka_app" | "staka_admin"): string {
  const u = new URL(databaseUrl);
  u.username = role;
  u.password = "";
  return u.toString();
}
