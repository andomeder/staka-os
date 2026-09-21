import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../src/agent-factory.ts";
import type { Env } from "../src/env.ts";

const env = {
  STAKA_STATE_DIR: join(tmpdir(), `staka-agent-state-reg-${process.pid}`),
  STAKA_TOKEN_PATH: join(tmpdir(), `staka-token-reg-${process.pid}`),
  STAKA_ORG_URL_PATH: join(tmpdir(), `staka-org-url-reg-${process.pid}`),
  STAKA_AGENT_HOST: "127.0.0.1",
  STAKA_AGENT_PORT: 7920,
  STAKA_HEARTBEAT_INTERVAL_MS: 60_000,
  STAKA_CONFIG_REFRESH_MS: 300_000,
} as Env;

describe("agent factory tool registration", () => {
  test("registers browser, fs, deliver, and atspi tools alongside the rest", () => {
    const agent = createAgent({ env, orgUrl: "https://org.example", token: "t" });
    const names = agent.state.tools.map((t) => t.name);
    for (const expected of [
      "browser_open",
      "browser_list_tabs",
      "browser_switch_tab",
      "browser_navigate",
      "browser_get_dom",
      "browser_get_selection",
      "browser_click",
      "browser_type",
      "browser_screenshot",
      "atspi_read",
      "fs_read_file",
      "org_deliver",
      "compositor_start_app",
      "org_users_search",
    ]) {
      expect(names).toContain(expected);
    }
  });

  test("the system prompt states the structured-access ladder and honest failure", () => {
    const agent = createAgent({ env, orgUrl: "https://org.example", token: "t" });
    const prompt = agent.state.systemPrompt;
    expect(prompt).toContain("Structured access ladder");
    expect(prompt).toContain("never invent results");
  });
});
