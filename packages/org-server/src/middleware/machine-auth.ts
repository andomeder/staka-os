import { eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import type { Db } from "../db/client.ts";
import { machines } from "../db/schema.ts";
import { bearerToken } from "../lib/http.ts";
import { verifyJwt, type JwtKeyring } from "../lib/jwt.ts";
import { MachineStatusCache } from "../lib/machine-status-cache.ts";

export type MachineAuth = {
  machineId: string;
};

declare module "hono" {
  interface ContextVariableMap {
    machineAuth: MachineAuth;
  }
}

export type MachineAuthDeps = {
  dbApp: Db;
  keyring: JwtKeyring;
  statusCache?: MachineStatusCache;
};

export function machineBearerAuth(deps: MachineAuthDeps): MiddlewareHandler {
  const statusCache = deps.statusCache ?? new MachineStatusCache();

  return async (c: Context, next) => {
    const token = bearerToken(c.req.header("authorization"));
    if (!token) return unauthorized(c);

    let payload;
    try {
      const verified = await verifyJwt(deps.keyring, token);
      payload = verified.payload;
    } catch {
      return unauthorized(c);
    }

    const machineId = typeof payload.sub === "string" ? payload.sub : null;
    if (!machineId) return unauthorized(c);
    if (payload.typ !== "machine") return unauthorized(c);

    let status = statusCache.get(machineId);
    if (!status) {
      const [row] = await deps.dbApp
        .select({ status: machines.status })
        .from(machines)
        .where(eq(machines.id, machineId))
        .limit(1);
      if (!row) return unauthorized(c);
      status = row.status;
      statusCache.set(machineId, status);
    }

    if (status === "suspended" || status === "revoked") {
      return forbidden(c);
    }
    if (status !== "approved" && status !== "active") {
      return forbidden(c);
    }

    c.set("machineAuth", { machineId });
    await next();
  };
}

function unauthorized(c: Context) {
  return c.json(
    { error: "unauthorized", request_id: c.get("requestId") },
    401,
  );
}

function forbidden(c: Context) {
  return c.json({ error: "forbidden", request_id: c.get("requestId") }, 403);
}
