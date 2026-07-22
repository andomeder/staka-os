import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv } from "../src/env.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function tempFile(name: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "staka-env-"));
  dirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, contents, "utf8");
  return path;
}

describe("loadEnv", () => {
  test("refuses auto-approve in production", () => {
    expect(() =>
      loadEnv(
        {
          NODE_ENV: "production",
          STAKA_AUTO_APPROVE: "1",
          STAKA_AUTO_APPROVE_CONFIRM: "1",
          DATABASE_URL: "postgres://x",
          DATABASE_APP_URL: "postgres://app",
          DATABASE_ADMIN_URL: "postgres://admin",
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

  test("trust proxy defaults off", () => {
    const env = loadEnv(
      {
        NODE_ENV: "development",
        DATABASE_URL: "postgres://x",
        STAKA_JWT_KEYS: "[]",
      },
      { requireSecrets: true },
    );
    expect(env.TRUST_PROXY).toBe(false);
  });

  test("loads secrets from *_FILE", () => {
    const db = tempFile("db", "postgres://file-owner\n");
    const jwt = tempFile("jwt", "[]\n");
    const env = loadEnv(
      {
        NODE_ENV: "development",
        DATABASE_URL_FILE: db,
        STAKA_JWT_KEYS_FILE: jwt,
      },
      { requireSecrets: true },
    );
    expect(env.DATABASE_URL).toBe("postgres://file-owner");
    expect(env.STAKA_JWT_KEYS).toBe("[]");
  });

  test("production requires distinct app and admin urls", () => {
    expect(() =>
      loadEnv(
        {
          NODE_ENV: "production",
          DATABASE_URL: "postgres://owner",
          DATABASE_APP_URL: "postgres://same",
          DATABASE_ADMIN_URL: "postgres://same",
          STAKA_JWT_KEYS: "[]",
        },
        { requireSecrets: true },
      ),
    ).toThrow(/distinct DATABASE_APP_URL/);
  });

  test("production allows single role with explicit escape", () => {
    const env = loadEnv(
      {
        NODE_ENV: "production",
        DATABASE_URL: "postgres://owner",
        DATABASE_APP_URL: "postgres://same",
        DATABASE_ADMIN_URL: "postgres://same",
        STAKA_ALLOW_SINGLE_DB_ROLE: "1",
        STAKA_JWT_KEYS: "[]",
      },
      { requireSecrets: true },
    );
    expect(env.DATABASE_APP_URL).toBe("postgres://same");
  });

  test("production requires app and admin urls set", () => {
    expect(() =>
      loadEnv(
        {
          NODE_ENV: "production",
          DATABASE_URL: "postgres://owner",
          STAKA_JWT_KEYS: "[]",
        },
        { requireSecrets: true },
      ),
    ).toThrow(/DATABASE_APP_URL and DATABASE_ADMIN_URL/);
  });
});
