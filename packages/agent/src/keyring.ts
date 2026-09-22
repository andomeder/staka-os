/**
 * Model API key resolution.
 *
 * The org-configured model key lives in the desktop keyring (GNOME
 * Keyring / KWallet, both Secret Service implementations) and is read with
 * `secret-tool` from libsecret. Resolution order:
 *
 *   1. env STAKA_MODEL_API_KEY (CI / headless / explicit override)
 *   2. Secret Service lookup: service=staka, username=model-api-key
 *   3. none - the agent runs without a model key and says so
 *
 * The key value is never logged; callers report only the source.
 *
 * Storing the key:
 *
 *   secret-tool store --label=Staka service staka username model-api-key
 *   (prompt, then paste the key on stdin)
 */

import type { Env } from "./env.ts";

export type KeySource = "env" | "keyring" | "none";

export type ResolvedApiKey = {
  key: string | null;
  source: KeySource;
};

export type SecretToolRunner = (
  args: string[],
) => Promise<{ exitCode: number; stdout: string }>;

const SECRET_TOOL_ARGS = ["lookup", "service", "staka", "username", "model-api-key"];

function systemRunner(): SecretToolRunner {
  return async (args) => {
    const proc = Bun.spawn(["secret-tool", ...args], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    return { exitCode, stdout };
  };
}

/**
 * Resolves the model API key. A missing secret-tool binary, a locked
 * keyring, or a lookup failure all resolve to "none" rather than throwing:
 * the agent must degrade to "no model configured", not crash on boot.
 */
export async function resolveModelApiKey(
  env: Env,
  run: SecretToolRunner = systemRunner(),
): Promise<ResolvedApiKey> {
  if (env.STAKA_MODEL_API_KEY) {
    return { key: env.STAKA_MODEL_API_KEY, source: "env" };
  }
  try {
    const { exitCode, stdout } = await run(SECRET_TOOL_ARGS);
    if (exitCode !== 0) return { key: null, source: "none" };
    const key = stdout.trim();
    return key ? { key, source: "keyring" } : { key: null, source: "none" };
  } catch {
    return { key: null, source: "none" };
  }
}
