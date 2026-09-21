export type RateLimitResult =
  | { ok: true }
  | { ok: false; retryAfterSec: number };

type Bucket = {
  count: number;
  resetAt: number;
};

/** Single-process fixed window limiter. Restart resets buckets. */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  hit(key: string, now = Date.now()): RateLimitResult {
    const existing = this.buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return { ok: true };
    }
    if (existing.count >= this.limit) {
      return {
        ok: false,
        retryAfterSec: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
      };
    }
    existing.count += 1;
    return { ok: true };
  }

  reset(): void {
    this.buckets.clear();
  }
}

export type ActivationRateLimiters = {
  enrollIp: RateLimiter;
  enrollCode: RateLimiter;
  enrollHwid: RateLimiter;
  authIp: RateLimiter;
  authEmployee: RateLimiter;
  authCode: RateLimiter;
  statusIp: RateLimiter;
  adminLoginIp: RateLimiter;
  adminLoginEmployee: RateLimiter;
  usersSearch: RateLimiter;
  usageWrite: RateLimiter;
  deliver: RateLimiter;
};

export function createActivationRateLimiters(): ActivationRateLimiters {
  const minute = 60_000;
  return {
    enrollIp: new RateLimiter(5, minute),
    enrollCode: new RateLimiter(3, minute),
    enrollHwid: new RateLimiter(3, minute),
    authIp: new RateLimiter(5, minute),
    authEmployee: new RateLimiter(5, minute),
    authCode: new RateLimiter(5, minute),
    statusIp: new RateLimiter(30, minute),
    adminLoginIp: new RateLimiter(5, minute),
    adminLoginEmployee: new RateLimiter(5, minute),
    usersSearch: new RateLimiter(30, minute),
    usageWrite: new RateLimiter(120, minute),
    deliver: new RateLimiter(20, minute),
  };
}

export function clientIp(
  headers: Headers,
  opts: { trustProxy?: boolean; fallback?: string } = {},
): string {
  const fallback = opts.fallback ?? "unknown";
  if (opts.trustProxy) {
    const forwarded = headers.get("x-forwarded-for");
    if (forwarded) {
      const first = forwarded.split(",")[0]?.trim();
      if (first) return first;
    }
    const realIp = headers.get("x-real-ip")?.trim();
    if (realIp) return realIp;
  }
  return fallback;
}
