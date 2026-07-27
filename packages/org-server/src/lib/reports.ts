import { and, count, desc, eq, gt, isNull, lt, or } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { machines, usageLogs } from "../db/schema.ts";

export type MachineStatus =
  | "pending"
  | "approved"
  | "active"
  | "suspended"
  | "revoked";

export type ReportsSummary = {
  machines_by_status: Record<string, number>;
  recent_activations: number;
  stale_machines: number;
};

const machineListColumns = {
  id: machines.id,
  hostname: machines.hostname,
  status: machines.status,
  userId: machines.userId,
  hardwareId: machines.hardwareId,
  hwidDisplay: machines.hwidDisplay,
  provisionFlow: machines.provisionFlow,
  firstSeenAt: machines.firstSeenAt,
  approvedAt: machines.approvedAt,
  lastHeartbeatAt: machines.lastHeartbeatAt,
  createdAt: machines.createdAt,
};

export async function getReportsSummary(db: Db): Promise<ReportsSummary> {
  const statusRows = await db
    .select({
      status: machines.status,
      n: count(),
    })
    .from(machines)
    .groupBy(machines.status);

  const machines_by_status: Record<string, number> = {
    pending: 0,
    approved: 0,
    active: 0,
    suspended: 0,
    revoked: 0,
  };
  for (const row of statusRows) {
    machines_by_status[row.status] = Number(row.n);
  }

  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [recent] = await db
    .select({ n: count() })
    .from(usageLogs)
    .where(
      and(
        eq(usageLogs.eventType, "activation_approved"),
        gt(usageLogs.createdAt, dayAgo),
      ),
    );

  const [stale] = await db
    .select({ n: count() })
    .from(machines)
    .where(
      and(
        eq(machines.status, "active"),
        or(isNull(machines.lastHeartbeatAt), lt(machines.lastHeartbeatAt, dayAgo)),
      ),
    );

  return {
    machines_by_status,
    recent_activations: Number(recent?.n ?? 0),
    stale_machines: Number(stale?.n ?? 0),
  };
}

export async function listMachines(
  db: Db,
  opts: { status?: MachineStatus } = {},
) {
  if (opts.status) {
    return db
      .select(machineListColumns)
      .from(machines)
      .where(eq(machines.status, opts.status))
      .orderBy(desc(machines.createdAt));
  }
  return db
    .select(machineListColumns)
    .from(machines)
    .orderBy(desc(machines.createdAt));
}

export async function listStaleMachines(db: Db) {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return db
    .select(machineListColumns)
    .from(machines)
    .where(
      and(
        eq(machines.status, "active"),
        or(isNull(machines.lastHeartbeatAt), lt(machines.lastHeartbeatAt, dayAgo)),
      ),
    )
    .orderBy(machines.lastHeartbeatAt);
}
