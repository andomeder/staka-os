const ALLOWED = new Set([
  "approved",
  "created",
  "csrf",
  "invalid",
  "conflict",
  "not_pending",
  "not_found",
  "rate_limited",
  "revoked",
  "suspended",
  "user_not_found",
]);

export function sanitizeFlash(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  return ALLOWED.has(raw) ? raw : undefined;
}
