import { z } from "zod";

const boolish = z
  .enum(["0", "1", "true", "false"])
  .optional()
  .transform((v) => v === "1" || v === "true");

const EnvSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z.coerce.number().int().positive().default(8080),
    HOST: z.string().default("0.0.0.0"),
    DATABASE_URL: z.string().min(1).optional(),
    STAKA_JWT_KEYS: z.string().min(1).optional(),
    STAKA_AUTO_APPROVE: boolish.default(false),
    STAKA_AUTO_APPROVE_CONFIRM: boolish.default(false),
    STAKA_SEED_ADMIN_EMPLOYEE_ID: z.string().default("EMP-0001"),
    STAKA_SEED_ADMIN_PASSWORD: z.string().min(8).optional(),
    STAKA_SEED_ADMIN_DISPLAY_NAME: z.string().default("Staka Admin"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace"])
      .default("info"),
  })
  .strict();

export type Env = z.infer<typeof EnvSchema> & {
  DATABASE_URL: string;
  STAKA_JWT_KEYS: string;
};

const KNOWN_KEYS = [
  "NODE_ENV",
  "PORT",
  "HOST",
  "DATABASE_URL",
  "STAKA_JWT_KEYS",
  "STAKA_AUTO_APPROVE",
  "STAKA_AUTO_APPROVE_CONFIRM",
  "STAKA_SEED_ADMIN_EMPLOYEE_ID",
  "STAKA_SEED_ADMIN_PASSWORD",
  "STAKA_SEED_ADMIN_DISPLAY_NAME",
  "LOG_LEVEL",
] as const;

function pickKnown(
  raw: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const key of KNOWN_KEYS) {
    if (raw[key] !== undefined) out[key] = raw[key];
  }
  return out;
}

export function loadEnv(
  raw: Record<string, string | undefined> = process.env,
  opts: { requireSecrets?: boolean } = {},
): Env {
  const parsed = EnvSchema.parse(pickKnown(raw));

  if (parsed.STAKA_AUTO_APPROVE && parsed.NODE_ENV === "production") {
    throw new Error(
      "STAKA_AUTO_APPROVE cannot be enabled when NODE_ENV=production",
    );
  }

  if (parsed.STAKA_AUTO_APPROVE && !parsed.STAKA_AUTO_APPROVE_CONFIRM) {
    parsed.STAKA_AUTO_APPROVE = false;
  }

  const requireSecrets = opts.requireSecrets ?? parsed.NODE_ENV !== "test";
  if (requireSecrets) {
    if (!parsed.DATABASE_URL) {
      throw new Error("DATABASE_URL is required");
    }
    if (!parsed.STAKA_JWT_KEYS) {
      throw new Error("STAKA_JWT_KEYS is required");
    }
  }

  return {
    ...parsed,
    DATABASE_URL: parsed.DATABASE_URL ?? "",
    STAKA_JWT_KEYS: parsed.STAKA_JWT_KEYS ?? "",
  };
}
