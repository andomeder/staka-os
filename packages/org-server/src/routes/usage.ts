import { Hono } from "hono";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { usageLogs } from "../db/schema.ts";
import type { JwtKeyring } from "../lib/jwt.ts";
import type { MachineStatusCache } from "../lib/machine-status-cache.ts";
import { machineBearerAuth } from "../middleware/machine-auth.ts";
import type { ActivationRateLimiters } from "../lib/rate-limit.ts";

export type UsageDeps = {
  dbApp: Db;
  keyring: JwtKeyring;
  rateLimiters: ActivationRateLimiters;
  statusCache?: MachineStatusCache;
};

/// Event types a machine may write. Admin-side event types are excluded.
const MACHINE_EVENT_TYPES = [
  "agent_action",
  "agent_error",
  "skill_invoked",
  "agent_file_read",
] as const;

const usageBody = z.object({
  event_type: z.enum(MACHINE_EVENT_TYPES),
  detail: z.union([z.string().max(4000), z.record(z.string(), z.unknown())]).optional(),
});

export function usageRoutes(deps: UsageDeps) {
  const app = new Hono();

  const auth = machineBearerAuth({
    dbApp: deps.dbApp,
    keyring: deps.keyring,
    statusCache: deps.statusCache,
  });

  app.post("/v1/usage-logs", auth, async (c) => {
    const { machineId } = c.get("machineAuth");

    if (!deps.rateLimiters.usageWrite.hit(`machine:${machineId}`).ok) {
      return c.json(
        { error: "rate_limited", request_id: c.get("requestId") },
        429,
      );
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json(
        { error: "invalid_json", request_id: c.get("requestId") },
        400,
      );
    }
    const parsed = usageBody.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { error: "invalid_body", request_id: c.get("requestId") },
        400,
      );
    }

    const [row] = await deps.dbApp
      .insert(usageLogs)
      .values({
        machineId,
        eventType: parsed.data.event_type,
        payload: parsed.data.detail !== undefined ? { detail: parsed.data.detail } : {},
      })
      .returning({ id: usageLogs.id, createdAt: usageLogs.createdAt });

    return c.json(
      { id: row!.id, created_at: row!.createdAt.toISOString() },
      201,
    );
  });

  return app;
}
