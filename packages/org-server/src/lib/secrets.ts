import { readFileSync } from "node:fs";

/**
 * Resolve a secret from plain env or `NAME_FILE`.
 * When `NAME_FILE` is set it wins; missing/unreadable file hard-fails.
 * Never log returned values.
 */
export function resolveSecret(
  raw: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const fileKey = `${name}_FILE`;
  const filePath = raw[fileKey];
  if (filePath !== undefined && filePath !== "") {
    let contents: string;
    try {
      contents = readFileSync(filePath, "utf8");
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`failed to read ${fileKey}=${filePath}: ${reason}`);
    }
    return contents.replace(/\r?\n$/, "").trimEnd();
  }
  const plain = raw[name];
  if (plain === undefined || plain === "") return undefined;
  return plain;
}

/** Apply `*_FILE` resolution for the given secret names into a shallow copy. */
export function applySecretFiles(
  raw: Record<string, string | undefined>,
  names: readonly string[],
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...raw };
  for (const name of names) {
    const value = resolveSecret(raw, name);
    if (value !== undefined) {
      out[name] = value;
    } else {
      delete out[name];
    }
    delete out[`${name}_FILE`];
  }
  return out;
}

export const SECRET_ENV_NAMES = [
  "DATABASE_URL",
  "DATABASE_APP_URL",
  "DATABASE_ADMIN_URL",
  "STAKA_JWT_KEYS",
  "STAKA_SEED_ADMIN_PASSWORD",
] as const;
