import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { activationCodes, type ActivationCode } from "../db/schema.ts";
import {
  generateEnrollmentCode,
  hashEnrollmentCode,
  maskEnrollmentCode,
} from "./codes.ts";

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function createActivationCode(
  db: Db,
  input: {
    userId: string;
    createdBy: string;
    flow: "admin" | "self";
    maxUses?: number;
    expiresAt?: Date;
  },
): Promise<{ code: ActivationCode; plaintext: string }> {
  const plaintext = generateEnrollmentCode();
  const expiresAt =
    input.expiresAt ?? new Date(Date.now() + DEFAULT_TTL_MS);
  const [row] = await db
    .insert(activationCodes)
    .values({
      codeHash: hashEnrollmentCode(plaintext),
      codeDisplay: maskEnrollmentCode(plaintext),
      userId: input.userId,
      createdBy: input.createdBy,
      expiresAt,
      maxUses: input.maxUses ?? 1,
      flow: input.flow,
    })
    .returning();
  if (!row) throw new Error("failed to create activation code");
  return { code: row, plaintext };
}

export async function listActivationCodes(db: Db): Promise<ActivationCode[]> {
  return db
    .select()
    .from(activationCodes)
    .orderBy(desc(activationCodes.createdAt));
}

export async function revokeActivationCode(
  db: Db,
  id: string,
): Promise<ActivationCode | null> {
  const [row] = await db
    .update(activationCodes)
    .set({ revokedAt: new Date() })
    .where(and(eq(activationCodes.id, id), isNull(activationCodes.revokedAt)))
    .returning();
  return row ?? null;
}
