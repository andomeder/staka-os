import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { activationCodes, type ActivationCode } from "../db/schema.ts";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomBase32(bytes: number): string {
  const buf = randomBytes(bytes);
  let out = "";
  for (let i = 0; i < buf.length; i++) {
    out += ALPHABET[buf[i]! % ALPHABET.length]!;
  }
  return out;
}

/** STAKA-XXXX-XXXX-XXXX-XXXX (~100 bits from 20 base32 chars). */
export function generateEnrollmentCode(): string {
  const raw = randomBase32(20);
  const groups = raw.match(/.{1,4}/g) ?? [];
  return `STAKA-${groups.slice(0, 4).join("-")}`;
}

export function hashEnrollmentCode(code: string): string {
  return createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}

export function maskEnrollmentCode(code: string): string {
  const clean = code.trim().toUpperCase();
  if (clean.length < 8) return "STAKA-****";
  return `${clean.slice(0, 10)}…${clean.slice(-4)}`;
}

export function generateNonce(): string {
  return randomBase32(32);
}

export function hashNonce(nonce: string): string {
  return createHash("sha256").update(nonce).digest("hex");
}

export async function findValidCodeByHash(
  db: Db,
  codeHash: string,
  opts: { flow?: "admin" | "self" } = {},
): Promise<ActivationCode | null> {
  const [row] = await db
    .select()
    .from(activationCodes)
    .where(
      and(
        eq(activationCodes.codeHash, codeHash),
        isNull(activationCodes.revokedAt),
        sql`${activationCodes.expiresAt} > now()`,
        opts.flow ? eq(activationCodes.flow, opts.flow) : undefined,
      ),
    )
    .limit(1);
  if (!row) return null;
  if (row.uses >= row.maxUses) return null;
  return row;
}

/** Atomic use++ when still under max_uses and not expired/revoked. */
export async function consumeEnrollmentCode(
  db: Db,
  codeId: string,
): Promise<ActivationCode | null> {
  const rows = await db
    .update(activationCodes)
    .set({ uses: sql`${activationCodes.uses} + 1` })
    .where(
      and(
        eq(activationCodes.id, codeId),
        isNull(activationCodes.revokedAt),
        sql`${activationCodes.expiresAt} > now()`,
        lt(activationCodes.uses, activationCodes.maxUses),
      ),
    )
    .returning();
  return rows[0] ?? null;
}
