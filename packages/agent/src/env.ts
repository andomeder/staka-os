import { z } from "zod";

const EnvSchema = z.object({
  STAKA_STATE_DIR: z.string().default(`${process.env.HOME}/.local/share/staka/agent`),
  STAKA_TOKEN_PATH: z.string().default("/etc/staka/machine.token"),
  STAKA_ORG_URL_PATH: z.string().default("/etc/staka/org-url"),
  STAKA_AGENT_HOST: z.string().default("127.0.0.1"),
  STAKA_AGENT_PORT: z.coerce.number().default(7920),
  STAKA_MODEL_PROVIDER: z.string().optional(),
  STAKA_MODEL_ID: z.string().optional(),
  STAKA_MODEL_API_KEY: z.string().optional(),
  STAKA_MODEL_BASE_URL: z.string().optional(),
  STAKA_MODEL_CONTEXT_WINDOW: z.coerce.number().optional(),
  STAKA_MODEL_MAX_TOKENS: z.coerce.number().optional(),
  STAKA_HEARTBEAT_INTERVAL_MS: z.coerce.number().default(60_000),
  STAKA_CONFIG_REFRESH_MS: z.coerce.number().default(300_000),
  /// Colon- or comma-separated directories fs_read_file may read.
  STAKA_FS_ALLOWLIST: z.string().optional(),
  /// Profile dir for the Staka-managed Chromium.
  STAKA_BROWSER_PROFILE_DIR: z.string().optional(),
  /// Chromium binary for the Staka-managed browser.
  STAKA_CHROMIUM_BIN: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(): Env {
  return EnvSchema.parse(process.env);
}
