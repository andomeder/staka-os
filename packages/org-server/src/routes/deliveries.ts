import { Hono } from "hono";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { deliveries, usageLogs, users } from "../db/schema.ts";
import type { JwtKeyring } from "../lib/jwt.ts";
import type { MachineStatusCache } from "../lib/machine-status-cache.ts";
import { machineBearerAuth } from "../middleware/machine-auth.ts";
import type { ActivationRateLimiters } from "../lib/rate-limit.ts";

export type DeliveriesDeps = {
  dbApp: Db;
  keyring: JwtKeyring;
  rateLimiters: ActivationRateLimiters;
  statusCache?: MachineStatusCache;
};

const deliveryBody = z.object({
  to_employee_id: z.string().trim().min(1).max(64),
  summary: z.string().trim().min(1).max(2000),
  artifact_ref: z.string().trim().min(1).max(500).optional(),
});

export function deliveriesRoutes(deps: DeliveriesDeps) {
  const app = new Hono();

  const auth = machineBearerAuth({
    dbApp: deps.dbApp,
    keyring: deps.keyring,
    statusCache: deps.statusCache,
  });

  app.post("/v1/deliveries", auth, async (c) => {
    const { machineId } = c.get("machineAuth");

    if (!deps.rateLimiters.deliver.hit(`machine:${machineId}`).ok) {
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
    const parsed = deliveryBody.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { error: "invalid_body", request_id: c.get("requestId") },
        400,
      );
    }

    const [recipient] = await deps.dbApp
      .select({
        id: users.id,
        employeeId: users.employeeId,
        displayName: users.displayName,
      })
      .from(users)
      .where(
        and(
          eq(users.employeeId, parsed.data.to_employee_id),
          isNull(users.deletedAt),
        ),
      )
      .limit(1);
    if (!recipient) {
      return c.json(
        { error: "user_not_found", request_id: c.get("requestId") },
        404,
      );
    }

    const [row] = await deps.dbApp
      .insert(deliveries)
      .values({
        machineId,
        toUserId: recipient.id,
        summary: parsed.data.summary,
        ...(parsed.data.artifact_ref
          ? { artifactRef: parsed.data.artifact_ref }
          : {}),
      })
      .returning({ id: deliveries.id, createdAt: deliveries.createdAt });

    await deps.dbApp.insert(usageLogs).values({
      machineId,
      eventType: "delivery_created",
      payload: {
        delivery_id: row!.id,
        to_user_id: recipient.id,
        has_artifact: parsed.data.artifact_ref !== undefined,
      },
    });

    return c.json(
      {
        id: row!.id,
        to_user: {
          employee_id: recipient.employeeId,
          display_name: recipient.displayName,
        },
        summary: parsed.data.summary,
        ...(parsed.data.artifact_ref
          ? { artifact_ref: parsed.data.artifact_ref }
          : {}),
        created_at: row!.createdAt.toISOString(),
      },
      201,
    );
  });

  return app;
}
