import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const CSRF_TTL_MS = 8 * 60 * 60 * 1000;

export type CsrfToken = {
  token: string;
  expiresAt: number;
};

function b64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromB64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Buffer.from(b64, "base64");
}

export function createCsrfSigner(secret: string) {
  if (!secret || secret.length < 16) {
    throw new Error("csrf secret must be at least 16 characters");
  }

  function sign(payload: string): string {
    return b64url(createHmac("sha256", secret).update(payload).digest());
  }

  function mint(now = Date.now()): CsrfToken {
    const nonce = b64url(randomBytes(18));
    const exp = now + CSRF_TTL_MS;
    const body = `${nonce}.${exp}`;
    const token = `${body}.${sign(body)}`;
    return { token, expiresAt: exp };
  }

  function verify(token: string, now = Date.now()): boolean {
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    const [nonce, expRaw, sig] = parts;
    if (!nonce || !expRaw || !sig) return false;
    const exp = Number(expRaw);
    if (!Number.isFinite(exp) || exp <= now) return false;
    const body = `${nonce}.${expRaw}`;
    const expected = sign(body);
    try {
      const a = fromB64url(sig);
      const b = fromB64url(expected);
      if (a.length !== b.length) return false;
      return timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  /** Double-submit: cookie value and form/header value must match and verify. */
  function verifyPair(
    cookieToken: string | undefined,
    submittedToken: string | undefined,
    now = Date.now(),
  ): boolean {
    if (!cookieToken || !submittedToken) return false;
    if (cookieToken.length !== submittedToken.length) return false;
    try {
      const a = Buffer.from(cookieToken, "utf8");
      const b = Buffer.from(submittedToken, "utf8");
      if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
    } catch {
      return false;
    }
    return verify(cookieToken, now);
  }

  return { mint, verify, verifyPair };
}

export type CsrfSigner = ReturnType<typeof createCsrfSigner>;

export function csrfSecretFromJwtKeys(jwtKeysJson: string): string {
  return createHmac("sha256", "staka-csrf-v1")
    .update(jwtKeysJson)
    .digest("hex");
}
