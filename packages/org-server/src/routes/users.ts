import { Hono } from "hono";
import { and, asc, ilike, isNull, or } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { machines, users } from "../db/schema.ts";
import type { JwtKeyring } from "../lib/jwt.ts";
import type { MachineStatusCache } from "../lib/machine-status-cache.ts";
import { machineBearerAuth } from "../middleware/machine-auth.ts";
import type { ActivationRateLimiters } from "../lib/rate-limit.ts";

export type UsersSearchDeps = {
  dbApp: Db;
  keyring: JwtKeyring;
  rateLimiters: ActivationRateLimiters;
  statusCache?: MachineStatusCache;
};

const searchQuery = z.object({
  q: z.string().trim().min(1).max(64),
  limit: z.coerce.number().int().min(1).max(25).default(10),
});

export function usersSearchRoutes(deps: UsersSearchDeps) {
  const app = new Hono();

  const auth = machineBearerAuth({
    dbApp: deps.dbApp,
    keyring: deps.keyring,
    statusCache: deps.statusCache,
  });

  app.get("/v1/users/search", auth, async (c) => {
    const { machineId } = c.get("machineAuth");

    if (!deps.rateLimiters.usersSearch.hit(`machine:${machineId}`).ok) {
      return c.json(
        { error: "rate_limited", request_id: c.get("requestId") },
        429,
      );
    }

    const parsed = searchQuery.safeParse({
      q: c.req.query("q") ?? "",
      limit: c.req.query("limit") ?? undefined,
    });
    if (!parsed.success) {
      return c.json(
        { error: "invalid_query", request_id: c.get("requestId") },
        400,
      );
    }

    const pattern = `%${parsed.data.q}%`;
    const rows = await deps.dbApp
      .select({
        id: users.id,
        employeeId: users.employeeId,
        displayName: users.displayName,
        role: users.role,
        status: users.status,
      })
      .from(users)
      .where(
        and(
          isNull(users.deletedAt),
          or(ilike(users.employeeId, pattern), ilike(users.displayName, pattern)),
        ),
      )
      .orderBy(asc(users.employeeId))
      .limit(parsed.data.limit);

    return c.json({
      users: rows.map((u) => ({
        id: u.id,
        employee_id: u.employeeId,
        display_name: u.displayName,
        role: u.role,
        status: u.status,
      })),
      count: rows.length,
    });
  });

  return app;
}
