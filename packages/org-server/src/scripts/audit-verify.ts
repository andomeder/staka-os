import { applySecretFiles, SECRET_ENV_NAMES } from "../lib/secrets.ts";
import { createDb } from "../db/client.ts";
import { verifyAuditChain } from "../lib/audit.ts";

export async function runAuditVerify(
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const resolved = applySecretFiles(env, SECRET_ENV_NAMES);
  const databaseUrl = resolved.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  const db = createDb(databaseUrl);
  try {
    const result = await verifyAuditChain(db);
    if (!result.ok) {
      console.error("audit chain broken", result);
      process.exitCode = 1;
      return;
    }
    console.log(`audit chain ok (${result.checked} rows)`);
  } finally {
    await db.$client.end({ timeout: 2 });
  }
}

if (import.meta.main) {
  runAuditVerify().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
