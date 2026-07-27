import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

export type Db = ReturnType<typeof createDb>;

export function createDb(databaseUrl: string) {
  const sql = postgres(databaseUrl, {
    max: 10,
    prepare: false,
  });
  const db = drizzle(sql, { schema });
  return Object.assign(db, { $client: sql });
}

export async function checkDb(databaseUrl: string): Promise<boolean> {
  const sql = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 1 });
  }
}
