import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type {
  ConfigResponse,
  MachineMeResponse,
  UserSearchResponse,
  UsageLogResponse,
  } from "@staka/protocol";
import { UsageLogRequest } from "@staka/protocol";
import type { Db } from "../db/client.ts";
import { machines, usageLogs, users } from "../db/schema.ts";
import type { JwtKeyring } from "../lib/jwt.ts";
import type { MachineStatusCache } from "../lib/machine-status-cache.ts";
import { machineBearerAuth } from "../middleware/machine-auth.ts";
import type { ActivationRateLimiters } from "../lib/rate-limit.ts";
import { searchUsers } from "../lib/users.ts";

export type ConfigDeps = {
  dbApp: Db;
  keyring: JwtKeyring;
  statusCache?: MachineStatusCache;
  orgName?: string;
  rateLimiters?: ActivationRateLimiters;
};

export function buildConfig(orgName?: string): ConfigResponse {
  return {
    version: 1,
    org_name: orgName ?? "Staka Organization",
    features: {
      skills_sync: false,
      memory_sync: false,
    },
    model: {
      provider: null,
      model_id: null,
      base_url: null,
    },
    skill_pack_url: null,
    skill_pack_hash: null,
  };
}

export function configRoutes(deps: ConfigDeps) {
  const app = new Hono();

  const auth = machineBearerAuth({
    dbApp: deps.dbApp,
    keyring: deps.keyring,
    statusCache: deps.statusCache,
  });

  app.get("/v1/config", auth, async (c) => {
    const { machineId } = c.get("machineAuth");

    await deps.dbApp.insert(usageLogs).values({
      machineId,
      eventType: "config_pull",
      payload: {},
    });

    return c.json(buildConfig(deps.orgName));
  });

  app.get("/v1/machines/me", auth, async (c) => {
    const { machineId } = c.get("machineAuth");

    const rows = await deps.dbApp
      .select({
        machineId: machines.id,
        hostname: machines.hostname,
        status: machines.status,
        provisionFlow: machines.provisionFlow,
        firstSeenAt: machines.firstSeenAt,
        lastHeartbeatAt: machines.lastHeartbeatAt,
        userId: users.id,
        employeeId: users.employeeId,
        displayName: users.displayName,
        email: users.email,
        userStatus: users.status,
      })
      .from(machines)
      .innerJoin(users, eq(machines.userId, users.id))
      .where(eq(machines.id, machineId))
      .limit(1);

    const row = rows[0];
    if (!row) {
      return c.json(
        { error: "machine_not_found", request_id: c.get("requestId") },
        404,
      );
    }

    const body: MachineMeResponse = {
      machine: {
        id: row.machineId,
        hostname: row.hostname,
        status: row.status,
        provision_flow: row.provisionFlow,
        first_seen_at: row.firstSeenAt.toISOString(),
        last_heartbeat_at: row.lastHeartbeatAt
          ? row.lastHeartbeatAt.toISOString()
          : null,
      },
      user: {
        id: row.userId,
        employee_id: row.employeeId,
        display_name: row.displayName,
        email: row.email,
        status: row.userStatus,
      },
    };

    return c.json(body);
  });

  app.get("/v1/users/search", auth, async (c) => {
    const { machineId } = c.get("machineAuth");
    const q = c.req.query("q")?.trim() ?? "";
    if (q.length < 2) {
      return c.json(
        { error: "invalid_query", request_id: c.get("requestId") },
        400,
      );
    }

    if (deps.rateLimiters) {
      const hit = deps.rateLimiters.usersSearch.hit(machineId);
      if (!hit.ok) {
        c.header("Retry-After", String(hit.retryAfterSec));
        return c.json(
          { error: "rate_limited", request_id: c.get("requestId") },
          429,
        );
      }
    }

    const rows = await searchUsers(deps.dbApp, q, 10);

    await deps.dbApp.insert(usageLogs).values({
      machineId,
      eventType: "agent_user_search",
      payload: { q },
    });

    const body: UserSearchResponse = rows.map((row) => ({
      employee_id: row.employeeId,
      display_name: row.displayName,
      email: row.email,
      status: row.status,
    }));

    return c.json(body);
  });

  app.post("/v1/usage-logs", auth, async (c) => {
    const { machineId } = c.get("machineAuth");

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json(
        { error: "invalid_body", request_id: c.get("requestId") },
        400,
      );
    }

    const parsed = UsageLogRequest.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { error: "invalid_body", request_id: c.get("requestId") },
        400,
      );
    }

    await deps.dbApp.insert(usageLogs).values({
      machineId,
      eventType: parsed.data.event_type,
      payload: { detail: parsed.data.detail ?? null },
    });

    const body: UsageLogResponse = { ok: true };
    return c.json(body);
  });

  return app;
}
