import { createHash } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { adminAuditLog } from "../db/schema.ts";

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
    const [prev] = await tx
      .select({
        id: adminAuditLog.id,
        actorUserId: adminAuditLog.actorUserId,
        action: adminAuditLog.action,
        targetType: adminAuditLog.targetType,
        targetId: adminAuditLog.targetId,
        payload: adminAuditLog.payload,
        createdAt: adminAuditLog.createdAt,
        prevHash: adminAuditLog.prevHash,
      })
      .from(adminAuditLog)
      .orderBy(desc(adminAuditLog.id))
      .limit(1);

    const prevHash = prev
      ? rowHash({
          id: prev.id,
          actorUserId: prev.actorUserId,
          action: prev.action,
          targetType: prev.targetType,
          targetId: prev.targetId,
          payload: prev.payload,
          createdAt: prev.createdAt,
          prevHash: prev.prevHash,
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
