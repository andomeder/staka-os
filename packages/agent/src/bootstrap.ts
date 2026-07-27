import { readFile } from "node:fs/promises";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "./env.ts";

export type BootstrapResult = {
  machineId: string;
  orgUrl: string;
  token: string;
  jwks: ReturnType<typeof createRemoteJWKSet>;
};

export async function readTokenFile(path: string): Promise<string> {
  const raw = await readFile(path, "utf8");
  const token = raw.trim();
  if (!token) throw new Error(`token file is empty: ${path}`);
  return token;
}

export async function readOrgUrl(path: string): Promise<string> {
  const raw = await readFile(path, "utf8");
  const url = raw.trim().replace(/\/+$/, "");
  if (!url) throw new Error(`org-url file is empty: ${path}`);
  return url;
}

export async function verifyMachineToken(
  token: string,
  orgUrl: string,
): Promise<{ machineId: string; jwks: ReturnType<typeof createRemoteJWKSet> }> {
  const jwksUrl = new URL("/v1/.well-known/jwks.json", orgUrl);
  const jwks = createRemoteJWKSet(jwksUrl);

  const { payload, protectedHeader } = await jwtVerify(token, jwks, {
    algorithms: ["EdDSA"],
  });

  if (payload.typ !== "machine") {
    throw new Error(`unexpected token typ: ${payload.typ}`);
  }

  const machineId = typeof payload.sub === "string" ? payload.sub : null;
  if (!machineId) {
    throw new Error("token missing sub claim");
  }

  return { machineId, jwks };
}

export async function bootstrap(env: Env): Promise<BootstrapResult> {
  const token = await readTokenFile(env.STAKA_TOKEN_PATH);
  const orgUrl = await readOrgUrl(env.STAKA_ORG_URL_PATH);
  const { machineId, jwks } = await verifyMachineToken(token, orgUrl);
  return { machineId, orgUrl, token, jwks };
}

export function startHeartbeat(
  orgUrl: string,
  token: string,
  intervalMs: number,
  onStatus: (status: string) => void,
  onError: (err: Error) => void,
): { stop: () => void } {
  let backoff = intervalMs;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function beat() {
    if (stopped) return;
    try {
      const res = await fetch(`${orgUrl}/v1/activate/heartbeat`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });

      if (res.ok) {
        const body = (await res.json()) as { status?: string };
        backoff = intervalMs;
        if (body.status) onStatus(body.status);
      } else if (res.status === 403) {
        onStatus("suspended");
        backoff = intervalMs * 5;
      } else {
        backoff = Math.min(backoff * 2, intervalMs * 10);
      }
    } catch (err) {
      backoff = Math.min(backoff * 2, intervalMs * 10);
      onError(err instanceof Error ? err : new Error(String(err)));
    }

    if (!stopped) {
      timer = setTimeout(beat, backoff);
    }
  }

  timer = setTimeout(beat, intervalMs);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
