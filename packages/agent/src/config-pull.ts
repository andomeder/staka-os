import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ConfigResponse } from "@staka/protocol";
import type { Env } from "./env.ts";

export async function pullConfig(
  orgUrl: string,
  token: string,
  env: Env,
): Promise<ConfigResponse> {
  const res = await fetch(`${orgUrl}/v1/config`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    throw new Error(`config pull failed: ${res.status} ${res.statusText}`);
  }

  const body: unknown = await res.json();
  const parsed = ConfigResponse.safeParse(body);
  if (!parsed.success) {
    throw new Error(`invalid config response: ${parsed.error.message}`);
  }

  await cacheConfig(env, parsed.data);
  return parsed.data;
}

export async function cacheConfig(
  env: Env,
  config: ConfigResponse,
): Promise<void> {
  const dir = env.STAKA_STATE_DIR;
  await mkdir(dir, { recursive: true });
  const path = join(dir, "config.json");
  await writeFile(path, JSON.stringify(config, null, 2), "utf8");
}

export async function loadCachedConfig(
  env: Env,
): Promise<ConfigResponse | null> {
  try {
    const path = join(env.STAKA_STATE_DIR, "config.json");
    const raw = await readFile(path, "utf8");
    const parsed = ConfigResponse.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
