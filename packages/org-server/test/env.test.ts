import { describe, expect, test } from "bun:test";
import { loadEnv } from "../src/env.ts";

describe("loadEnv", () => {
  test("refuses auto-approve in production", () => {
    expect(() =>
      loadEnv(
        {
          NODE_ENV: "production",
          STAKA_AUTO_APPROVE: "1",
          STAKA_AUTO_APPROVE_CONFIRM: "1",
          DATABASE_URL: "postgres://x",
          STAKA_JWT_KEYS: "[]",
        },
        { requireSecrets: true },
      ),
    ).toThrow(/production/);
  });

  test("disables auto-approve without confirm flag", () => {
    const env = loadEnv(
      {
        NODE_ENV: "development",
        STAKA_AUTO_APPROVE: "1",
        DATABASE_URL: "postgres://x",
        STAKA_JWT_KEYS: "[]",
      },
      { requireSecrets: true },
    );
    expect(env.STAKA_AUTO_APPROVE).toBe(false);
  });

  test("enables auto-approve only with paired confirm in non-prod", () => {
    const env = loadEnv(
      {
        NODE_ENV: "development",
        STAKA_AUTO_APPROVE: "1",
        STAKA_AUTO_APPROVE_CONFIRM: "1",
        DATABASE_URL: "postgres://x",
        STAKA_JWT_KEYS: "[]",
      },
      { requireSecrets: true },
    );
    expect(env.STAKA_AUTO_APPROVE).toBe(true);
  });
});
