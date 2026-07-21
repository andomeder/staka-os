import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { adminAuditLog } from "../db/schema.ts";

/** Transaction-scoped advisory lock key for the audit tip. */
const AUDIT_TIP_LOCK = 872_314_001;

export type AuditAppendInput = {
  actorUserId: string;
  action: string;
  targetType: string;
  targetId: string;
  payload?: Record<string, unknown>;
};

function rowHash(parts: {
  id: number;
  actorUserId: string;
  action: string;
  targetType: string;
  targetId: string;
  payload: unknown;
  createdAt: Date;
  prevHash: string;
}): string {
  const material = [
    String(parts.id),
    parts.actorUserId,
    parts.action,
    parts.targetType,
    parts.targetId,
    JSON.stringify(parts.payload ?? {}),
    parts.createdAt.toISOString(),
    parts.prevHash,
  ].join("|");
  return createHash("sha256").update(material).digest("hex");
}

export async function appendAudit(
  db: Db,
  input: AuditAppendInput,
): Promise<typeof adminAuditLog.$inferSelect> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${AUDIT_TIP_LOCK})`);

    const prevRows = await tx.execute<{
      id: string;
      actor_user_id: string;
      action: string;
      target_type: string;
      target_id: string;
      payload: unknown;
      created_at: Date | string;
      prev_hash: string;
    }>(sql`
      select id, actor_user_id, action, target_type, target_id, payload, created_at, prev_hash
      from admin_audit_log
      order by id desc
      limit 1
      for update
    `);

    const prev = prevRows[0];
    const prevHash = prev
      ? rowHash({
          id: Number(prev.id),
          actorUserId: prev.actor_user_id,
          action: prev.action,
          targetType: prev.target_type,
          targetId: prev.target_id,
          payload: prev.payload,
          createdAt:
            prev.created_at instanceof Date
              ? prev.created_at
              : new Date(prev.created_at),
          prevHash: prev.prev_hash,
        })
      : "0".repeat(64);

    const [inserted] = await tx
      .insert(adminAuditLog)
      .values({
        actorUserId: input.actorUserId,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        payload: input.payload ?? {},
        prevHash,
      })
      .returning();

    if (!inserted) {
      throw new Error("failed to append audit log");
    }
    return inserted;
  });
}

export async function verifyAuditChain(db: Db): Promise<{
  ok: boolean;
  checked: number;
  brokenAt?: number;
}> {
  const rows = await db
    .select()
    .from(adminAuditLog)
    .orderBy(adminAuditLog.id);

  let expectedPrev = "0".repeat(64);
  let checked = 0;

  for (const row of rows) {
    if (row.prevHash !== expectedPrev) {
      return { ok: false, checked, brokenAt: row.id };
    }
    expectedPrev = rowHash({
      id: row.id,
      actorUserId: row.actorUserId,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      payload: row.payload,
      createdAt: row.createdAt,
      prevHash: row.prevHash,
    });
    checked += 1;
  }

  return { ok: true, checked };
}

export async function countAuditRows(db: Db): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(adminAuditLog);
  return row?.n ?? 0;
}

export async function getAuditById(db: Db, id: number) {
  const [row] = await db
    .select()
    .from(adminAuditLog)
    .where(eq(adminAuditLog.id, id))
    .limit(1);
  return row ?? null;
}
