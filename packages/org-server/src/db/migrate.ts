import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "./client.ts";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  const db = createDb(databaseUrl);
  await migrate(db, {
    migrationsFolder: new URL("../../db/migrations", import.meta.url).pathname,
  });
  await db.$client.end({ timeout: 2 });
  console.log("migrations applied");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
