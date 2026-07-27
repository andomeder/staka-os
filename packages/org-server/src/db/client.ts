import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

export type Db = ReturnType<typeof createDb>;

export type DbPools = {
  owner: Db;
  app: Db;
  admin: Db;
};

export function createDb(databaseUrl: string) {
  const sql = postgres(databaseUrl, {
    max: 10,
    prepare: false,
  });
  const db = drizzle(sql, { schema });
  return Object.assign(db, { $client: sql });
}

export function createDbPools(urls: {
  owner: string;
  app: string;
  admin: string;
}): DbPools {
  return {
    owner: createDb(urls.owner),
    app: createDb(urls.app),
    admin: createDb(urls.admin),
  };
}

export async function closeDbPools(pools: DbPools): Promise<void> {
  const clients = new Set([
    pools.owner.$client,
    pools.app.$client,
    pools.admin.$client,
  ]);
  await Promise.all(
    [...clients].map((client) => client.end({ timeout: 2 })),
  );
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
