import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { appMachineColumns, type AppMachine } from "../db/machine-columns.ts";
import { machines, usageLogs } from "../db/schema.ts";
import { generateNonce, hashNonce } from "./codes.ts";

export async function approveMachine(
  db: Db,
  input: { machineId: string; approvedBy: string },
): Promise<{ machine: AppMachine; enrollmentNonce: string } | null> {
  const nonce = generateNonce();
  const nonceHash = hashNonce(nonce);
  const now = new Date();

  const [updated] = await db
    .update(machines)
    .set({
      status: "approved",
      enrollmentNonceHash: nonceHash,
      enrollmentNoncePlain: nonce,
      approvedAt: now,
      approvedBy: input.approvedBy,
    })
    .where(and(eq(machines.id, input.machineId), eq(machines.status, "pending")))
    .returning(appMachineColumns);

  if (!updated) return null;

  await db.insert(usageLogs).values({
    machineId: updated.id,
    eventType: "nonce_issued",
    payload: { approved_by: input.approvedBy },
  });
  await db.insert(usageLogs).values({
    machineId: updated.id,
    eventType: "activation_approved",
    payload: { approved_by: input.approvedBy },
  });

  return { machine: updated, enrollmentNonce: nonce };
}

export async function suspendMachine(
  db: Db,
  machineId: string,
): Promise<AppMachine | null> {
  const [updated] = await db
    .update(machines)
    .set({
      status: "suspended",
      enrollmentNoncePlain: null,
    })
    .where(
      and(
        eq(machines.id, machineId),
        sql`${machines.status} in ('pending', 'approved', 'active')`,
      ),
    )
    .returning(appMachineColumns);
  return updated ?? null;
}

export async function revokeMachine(
  db: Db,
  machineId: string,
): Promise<AppMachine | null> {
  const [updated] = await db
    .update(machines)
    .set({
      status: "revoked",
      enrollmentNoncePlain: null,
    })
    .where(eq(machines.id, machineId))
    .returning(appMachineColumns);
  return updated ?? null;
}

/** Consume one-time nonce; returns machine if valid and still approved. */
export async function consumeEnrollmentNonce(
  db: Db,
  input: { machineId: string; enrollmentNonce: string },
): Promise<
  | { ok: true; machine: AppMachine }
  | { ok: false; reason: "not_found" | "bad_nonce" | "consumed" | "not_approved" }
> {
  const nonceHash = hashNonce(input.enrollmentNonce);

  return db.transaction(async (tx) => {
    const locked = await tx.execute<{
      id: string;
      status: AppMachine["status"];
      enrollment_nonce_hash: string | null;
      enrollment_nonce_plain: string | null;
    }>(sql`
      select id, status, enrollment_nonce_hash, enrollment_nonce_plain
      from machines
      where id = ${input.machineId}
      for update
    `);
    const row = locked[0];
    if (!row) return { ok: false as const, reason: "not_found" as const };

    if (row.status === "revoked" || row.status === "suspended") {
      return { ok: false as const, reason: "not_approved" as const };
    }

    if (row.status !== "approved") {
      if (
        row.enrollment_nonce_hash === nonceHash &&
        row.enrollment_nonce_plain == null
      ) {
        return { ok: false as const, reason: "consumed" as const };
      }
      return { ok: false as const, reason: "not_approved" as const };
    }

    if (!row.enrollment_nonce_hash || row.enrollment_nonce_hash !== nonceHash) {
      return { ok: false as const, reason: "bad_nonce" as const };
    }

    if (row.enrollment_nonce_plain == null) {
      return { ok: false as const, reason: "consumed" as const };
    }

    const [updated] = await tx
      .update(machines)
      .set({ enrollmentNoncePlain: null })
      .where(
        and(
          eq(machines.id, row.id),
          eq(machines.status, "approved"),
          eq(machines.enrollmentNonceHash, nonceHash),
          isNotNull(machines.enrollmentNoncePlain),
        ),
      )
      .returning(appMachineColumns);

    if (!updated) {
      return { ok: false as const, reason: "consumed" as const };
    }

    await tx.insert(usageLogs).values({
      machineId: updated.id,
      eventType: "token_issued",
      payload: {},
    });

    return { ok: true as const, machine: updated };
  });
}

export async function recordHeartbeat(
  db: Db,
  machineId: string,
  metrics?: Record<string, unknown>,
): Promise<AppMachine | null> {
  const now = new Date();
  const [updated] = await db
    .update(machines)
    .set({
      status: "active",
      lastHeartbeatAt: now,
    })
    .where(
      and(
        eq(machines.id, machineId),
        sql`${machines.status} in ('approved', 'active')`,
      ),
    )
    .returning(appMachineColumns);

  if (!updated) return null;

  await db.insert(usageLogs).values({
    machineId,
    eventType: "heartbeat",
    payload: metrics ? { metrics } : {},
  });

  return updated;
}
