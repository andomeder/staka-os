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

  test("defaults app/admin urls to owner when unset", () => {
    const env = loadEnv(
      {
        NODE_ENV: "development",
        DATABASE_URL: "postgres://owner@127.0.0.1:5432/staka",
        STAKA_JWT_KEYS: "[]",
      },
      { requireSecrets: true },
    );
    expect(env.DATABASE_APP_URL).toBe(env.DATABASE_URL);
    expect(env.DATABASE_ADMIN_URL).toBe(env.DATABASE_URL);
  });

  test("keeps explicit role pool urls", () => {
    const env = loadEnv(
      {
        NODE_ENV: "development",
        DATABASE_URL: "postgres://owner@127.0.0.1:5432/staka",
        DATABASE_APP_URL: "postgres://staka_app@127.0.0.1:5432/staka",
        DATABASE_ADMIN_URL: "postgres://staka_admin@127.0.0.1:5432/staka",
        STAKA_JWT_KEYS: "[]",
      },
      { requireSecrets: true },
    );
    expect(env.DATABASE_APP_URL).toContain("staka_app");
    expect(env.DATABASE_ADMIN_URL).toContain("staka_admin");
  });
});
