import {
  parseCliCommand,
  UnknownCliCommandError,
} from "./cli.ts";
import { runMigrate } from "./db/migrate.ts";
import { runSeed } from "./db/seed.ts";
import { applySecretFiles, SECRET_ENV_NAMES } from "./lib/secrets.ts";
import { runAuditVerify } from "./scripts/audit-verify.ts";
import { serve } from "./serve.ts";

async function main(): Promise<void> {
  const command = parseCliCommand(process.argv);

  switch (command) {
    case "serve": {
      const { app, server } = await serve();
      // Keep handles reachable for tests / tooling that import this module.
      Object.assign(globalThis, { __stakaApp: app, __stakaServer: server });
      break;
    }
    case "migrate": {
      const env = applySecretFiles(process.env, SECRET_ENV_NAMES);
      const migrateOpts: { databaseUrl?: string; migrationsDir?: string } =
        {};
      if (env.DATABASE_URL) migrateOpts.databaseUrl = env.DATABASE_URL;
      if (process.env.STAKA_MIGRATIONS_DIR) {
        migrateOpts.migrationsDir = process.env.STAKA_MIGRATIONS_DIR;
      }
      await runMigrate(migrateOpts);
      break;
    }
    case "seed": {
      if (process.env.NODE_ENV === "production") {
        if (process.env.STAKA_ALLOW_PROD_SEED !== "1") {
          throw new Error(
            "seed refused in production (set STAKA_ALLOW_PROD_SEED=1 to override)",
          );
        }
      }
      await runSeed(process.env);
      break;
    }
    case "audit-verify": {
      await runAuditVerify(process.env);
      break;
    }
    default: {
      const _exhaustive: never = command;
      throw new Error(`unknown command: ${_exhaustive}`);
    }
  }
}

const isDirect =
  import.meta.main ||
  process.argv[1]?.endsWith("staka-org-server") === true ||
  process.argv[1]?.endsWith("/index.ts") === true ||
  process.argv[1]?.endsWith("\\index.ts") === true;

if (isDirect) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(err instanceof UnknownCliCommandError ? 2 : 1);
  });
}

export { main, parseCliCommand, serve };
