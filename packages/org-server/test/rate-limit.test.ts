import { describe, expect, test } from "bun:test";
import { clientIp, RateLimiter } from "../src/lib/rate-limit.ts";

describe("rate limiter", () => {
  test("allows up to limit then blocks", () => {
    const rl = new RateLimiter(3, 60_000);
    const now = 1_000_000;
    expect(rl.hit("a", now).ok).toBe(true);
    expect(rl.hit("a", now + 1).ok).toBe(true);
    expect(rl.hit("a", now + 2).ok).toBe(true);
    const blocked = rl.hit("a", now + 3);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  test("window reset", () => {
    const rl = new RateLimiter(1, 1000);
    expect(rl.hit("b", 0).ok).toBe(true);
    expect(rl.hit("b", 500).ok).toBe(false);
    expect(rl.hit("b", 1000).ok).toBe(true);
  });

  test("clientIp ignores forwarded headers unless trustProxy", () => {
    const headers = new Headers({
      "x-forwarded-for": "203.0.113.9",
      "x-real-ip": "198.51.100.7",
    });
    expect(clientIp(headers, { fallback: "direct" })).toBe("direct");
    expect(clientIp(headers, { trustProxy: true, fallback: "direct" })).toBe(
      "203.0.113.9",
    );
  });
});
