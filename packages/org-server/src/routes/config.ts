import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { ConfigResponse, MachineMeResponse } from "@staka/protocol";
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

  return app;
}
