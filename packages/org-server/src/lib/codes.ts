import { createHash, randomBytes } from "node:crypto";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomBase32(bytes: number): string {
  const buf = randomBytes(bytes);
  let out = "";
  for (let i = 0; i < buf.length; i++) {
    out += ALPHABET[buf[i]! % ALPHABET.length]!;
  }
  return out;
}

/** STAKA-XXXX-XXXX-XXXX-XXXX from 32 bytes of entropy. */
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
