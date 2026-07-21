import { describe, expect, test } from "bun:test";
import { RateLimiter } from "../src/lib/rate-limit.ts";

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
});
