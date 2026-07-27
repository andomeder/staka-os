import { createDb } from "../db/client.ts";
import { verifyAuditChain } from "../lib/audit.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}
const db = createDb(databaseUrl);
const result = await verifyAuditChain(db);
await db.$client.end({ timeout: 2 });
if (!result.ok) {
  console.error("audit chain broken", result);
  process.exit(1);
}
console.log(`audit chain ok (${result.checked} rows)`);
