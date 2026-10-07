import { Hono } from "hono";
import { desc, eq, ilike, or } from "drizzle-orm";
import type {
  ConfigResponse,
  MachineMeResponse,
  UsageLogsResponse,
  UsersSearchResponse,
} from "@staka/protocol";
import type { Db } from "../db/client.ts";
import { machines, usageLogs, users } from "../db/schema.ts";
import type { JwtKeyring } from "../lib/jwt.ts";
import type { MachineStatusCache } from "../lib/machine-status-cache.ts";
import { machineBearerAuth } from "../middleware/machine-auth.ts";
import { latestSkillPack } from "../lib/skill-packs.ts";

export type ConfigDeps = {
  dbApp: Db;
  keyring: JwtKeyring;
  statusCache?: MachineStatusCache;
  orgName?: string;
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

    const config = buildConfig(deps.orgName);
    const latest = await latestSkillPack(deps.dbApp).catch(() => null);
    if (latest) {
      config.features.skills_sync = true;
      config.skill_pack_url = "/v1/skill-packs/pull";
      config.skill_pack_hash = latest.sha256;
    }
    return c.json(config);
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

  // Org directory search for machine-bound agents: non-PII profile fields
  // only, matched on employee id, display name, or email prefix.
  app.get("/v1/users/search", auth, async (c) => {
    const query = (c.req.query("q") ?? "").trim();
    const limitRaw = Number.parseInt(c.req.query("limit") ?? "20", 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50) : 20;

    if (query.length === 0) {
      const body: UsersSearchResponse = { query, count: 0, users: [] };
      return c.json(body);
    }

    const pattern = `%${query}%`;
    const rows = await deps.dbApp
      .select({
        employeeId: users.employeeId,
        displayName: users.displayName,
        email: users.email,
        role: users.role,
        status: users.status,
      })
      .from(users)
      .where(
        or(
          ilike(users.employeeId, pattern),
          ilike(users.displayName, pattern),
          ilike(users.email, pattern),
        ),
      )
      .orderBy(users.employeeId)
      .limit(limit);

    const body: UsersSearchResponse = {
      query,
      count: rows.length,
      users: rows,
    };
    return c.json(body);
  });

  // Recent usage-log entries for the calling machine, newest first.
  app.get("/v1/usage-logs", auth, async (c) => {
    const { machineId } = c.get("machineAuth");
    const limitRaw = Number.parseInt(c.req.query("limit") ?? "50", 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;

    const rows = await deps.dbApp
      .select({
        id: usageLogs.id,
        eventType: usageLogs.eventType,
        payload: usageLogs.payload,
        createdAt: usageLogs.createdAt,
      })
      .from(usageLogs)
      .where(eq(usageLogs.machineId, machineId))
      .orderBy(desc(usageLogs.createdAt))
      .limit(limit);

    const body: UsageLogsResponse = {
      machine_id: machineId,
      count: rows.length,
      logs: rows.map((r) => ({
        id: r.id,
        event_type: r.eventType,
        payload: r.payload as Record<string, unknown>,
        created_at: r.createdAt.toISOString(),
      })),
    };
    return c.json(body);
  });

  // Record one agent activity event for the calling machine.
  app.post("/v1/usage-logs", auth, async (c) => {
    const { machineId } = c.get("machineAuth");
    const raw = await c.req.json().catch(() => null);
    const eventType = (raw as { event_type?: unknown } | null)?.event_type;
    const allowed = ["agent_action", "agent_error", "skill_invoked"];
    if (typeof eventType !== "string" || !allowed.includes(eventType)) {
      return c.json(
        { error: "invalid_event_type", request_id: c.get("requestId") },
        400,
      );
    }
    const detail = (raw as { detail?: unknown }).detail;
    const payload =
      typeof detail === "string" && detail.length > 0
        ? { detail: detail.slice(0, 1000) }
        : {};

    const inserted = await deps.dbApp
      .insert(usageLogs)
      .values({ machineId, eventType, payload })
      .returning({ id: usageLogs.id, createdAt: usageLogs.createdAt });

    return c.json({
      ok: true,
      id: inserted[0]?.id ?? null,
      created_at: inserted[0]?.createdAt.toISOString() ?? null,
    });
  });

  return app;
}
