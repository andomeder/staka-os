import { describe, expect, test } from "bun:test";
import { loadEnv } from "../src/env.ts";

describe("loadEnv", () => {
  const saved = { ...process.env };

  function resetEnv() {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("STAKA_")) delete process.env[key];
    }
  }

  test("defaults when no env vars set", () => {
    resetEnv();
    const env = loadEnv();
    expect(env.STAKA_AGENT_HOST).toBe("127.0.0.1");
    expect(env.STAKA_AGENT_PORT).toBe(7920);
    expect(env.STAKA_HEARTBEAT_INTERVAL_MS).toBe(60_000);
    expect(env.STAKA_CONFIG_REFRESH_MS).toBe(300_000);
    expect(env.STAKA_TOKEN_PATH).toBe("/etc/staka/machine.token");
    expect(env.STAKA_ORG_URL_PATH).toBe("/etc/staka/org-url");
    expect(env.STAKA_MODEL_PROVIDER).toBeUndefined();
    expect(env.STAKA_MODEL_API_KEY).toBeUndefined();
  });

  test("overrides from env", () => {
    resetEnv();
    process.env.STAKA_AGENT_PORT = "9999";
    process.env.STAKA_MODEL_PROVIDER = "anthropic";
    process.env.STAKA_MODEL_ID = "claude-sonnet-4-20250514";
    process.env.STAKA_MODEL_API_KEY = "sk-test";
    process.env.STAKA_HEARTBEAT_INTERVAL_MS = "5000";
    const env = loadEnv();
    expect(env.STAKA_AGENT_PORT).toBe(9999);
    expect(env.STAKA_MODEL_PROVIDER).toBe("anthropic");
    expect(env.STAKA_MODEL_ID).toBe("claude-sonnet-4-20250514");
    expect(env.STAKA_MODEL_API_KEY).toBe("sk-test");
    expect(env.STAKA_HEARTBEAT_INTERVAL_MS).toBe(5000);
  });

  test("rejects invalid port", () => {
    resetEnv();
    process.env.STAKA_AGENT_PORT = "not-a-number";
    expect(() => loadEnv()).toThrow();
  });

  test("state dir defaults to home-based path", () => {
    resetEnv();
    const env = loadEnv();
    expect(env.STAKA_STATE_DIR).toContain("staka/agent");
  });
});
