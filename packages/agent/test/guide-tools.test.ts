import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGuideTools, defaultGuideShellPath } from "../src/tools/guide.ts";
import { createAgent } from "../src/agent-factory.ts";
import type { Env } from "../src/env.ts";

type RunCall = { argv: string[]; result: { code: number; stdout: string; stderr: string } };

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content[0].text ?? "";
}

function toolByName(tools: { name: string }[], name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`missing tool: ${name}`);
  return tool;
}

function makeTools(calls: RunCall[], result?: Partial<RunCall["result"]>) {
  return createGuideTools({
    shellPath: "/opt/staka/shell/shell",
    run: async (argv: string[]) => {
      const res = { code: 0, stdout: "", stderr: "", ...result };
      calls.push({ argv, result: res });
      return res;
    },
  });
}

describe("defaultGuideShellPath", () => {
  test("appends /shell to STAKA_SHELL_PATH", () => {
    process.env.STAKA_SHELL_PATH = "/opt/staka/shell";
    expect(defaultGuideShellPath()).toBe("/opt/staka/shell/shell");
    delete process.env.STAKA_SHELL_PATH;
  });

  test("falls back to the installed shell root", () => {
    delete process.env.STAKA_SHELL_PATH;
    expect(defaultGuideShellPath()).toBe("/opt/staka/shell/shell");
  });
});

describe("createGuideTools", () => {
  test("exposes the guide tool surface", () => {
    const tools = makeTools([]);
    expect(tools.map((t) => t.name)).toEqual(["guide_highlight", "guide_sequence"]);
  });

  test("guide_highlight sends the payload over the shell IPC bridge", async () => {
    const calls: RunCall[] = [];
    const tools = makeTools(calls);
    const highlight = toolByName(tools, "guide_highlight");
    const result = await highlight.execute("t1", { x: 1200, y: 340, w: 200, h: 40, label: "File > Export" });
    expect(calls).toHaveLength(1);
    expect(calls[0].argv.slice(0, 8)).toEqual([
      "qs",
      "-p",
      "/opt/staka/shell/shell",
      "ipc",
      "call",
      "--",
      "guide",
      "highlight",
    ]);
    const payload = JSON.parse(calls[0].argv[8]);
    expect(payload).toEqual({ x: 1200, y: 340, w: 200, h: 40, label: "File > Export" });
    expect(textOf(result)).toContain("Highlighted target (1200, 340 200x40) (File > Export)");
  });

  test("guide_highlight omits optional fields instead of sending defaults", async () => {
    const calls: RunCall[] = [];
    const tools = makeTools(calls);
    const highlight = toolByName(tools, "guide_highlight");
    await highlight.execute("t1", { x: 10, y: 20 });
    const payload = JSON.parse(calls[0].argv[8]);
    expect(payload).toEqual({ x: 10, y: 20 });
  });

  test("guide_highlight rejects bad coordinates without calling the shell", async () => {
    const calls: RunCall[] = [];
    const tools = makeTools(calls);
    const highlight = toolByName(tools, "guide_highlight");
    const result = await highlight.execute("t1", { x: "left" });
    expect(calls).toHaveLength(0);
    expect(textOf(result)).toContain("steps[0].x must be a number");
  });

  test("guide_highlight truncates over-long labels", async () => {
    const calls: RunCall[] = [];
    const tools = makeTools(calls);
    const highlight = toolByName(tools, "guide_highlight");
    const result = await highlight.execute("t1", { x: 1, y: 2, label: "x".repeat(120) });
    expect(calls).toHaveLength(0);
    expect(textOf(result)).toContain("at most 80 characters");
  });

  test("guide_sequence validates, orders, and forwards every step", async () => {
    const calls: RunCall[] = [];
    const tools = makeTools(calls);
    const sequence = toolByName(tools, "guide_sequence");
    const result = await sequence.execute("t1", {
      steps: [
        { x: 100, y: 200, label: "View menu", durationMs: 3000 },
        { x: 300.6, y: 400.4, w: 240, h: 80 },
      ],
    });
    expect(calls).toHaveLength(1);
    const payload = JSON.parse(calls[0].argv[8]);
    expect(payload.steps).toEqual([
      { x: 100, y: 200, label: "View menu", durationMs: 3000 },
      { x: 301, y: 400, w: 240, h: 80 },
    ]);
    expect(textOf(result)).toContain("2 steps");
  });

  test("guide_sequence rejects empty and oversized step lists", async () => {
    const calls: RunCall[] = [];
    const tools = makeTools(calls);
    const sequence = toolByName(tools, "guide_sequence");
    const empty = await sequence.execute("t1", { steps: [] });
    expect(textOf(empty)).toContain("non-empty array");
    const big = await sequence.execute("t1", {
      steps: Array.from({ length: 11 }, (_, i) => ({ x: i, y: i })),
    });
    expect(textOf(big)).toContain("at most 10 steps");
    expect(calls).toHaveLength(0);
  });

  test("a missing shell degrades to a text message, not a throw", async () => {
    const calls: RunCall[] = [];
    const tools = makeTools(calls, { code: 1, stderr: "staka-shell is not running" });
    const highlight = toolByName(tools, "guide_highlight");
    const result = await highlight.execute("t1", { x: 5, y: 5 });
    expect(textOf(result)).toContain("guide overlay unavailable");
    expect(textOf(result)).toContain("staka-shell is not running");
  });

  test("a shell without the guide target is reported as unavailable", async () => {
    const calls: RunCall[] = [];
    const tools = makeTools(calls, { code: 0, stdout: "Target not found." });
    const highlight = toolByName(tools, "guide_highlight");
    const result = await highlight.execute("t1", { x: 5, y: 5 });
    expect(textOf(result)).toContain("guide overlay unavailable");
    expect(textOf(result)).toContain("no guide IPC target");
  });
});

describe("agent factory tool registration", () => {
  const env = {
    STAKA_STATE_DIR: join(tmpdir(), `staka-guide-agent-state-${process.pid}`),
    STAKA_TOKEN_PATH: join(tmpdir(), `staka-guide-token-${process.pid}`),
    STAKA_ORG_URL_PATH: join(tmpdir(), `staka-guide-org-url-${process.pid}`),
    STAKA_AGENT_HOST: "127.0.0.1",
    STAKA_AGENT_PORT: 7920,
    STAKA_HEARTBEAT_INTERVAL_MS: 60_000,
    STAKA_CONFIG_REFRESH_MS: 300_000,
  } as Env;

  test("registers the guide tools on the agent", () => {
    const agent = createAgent({ env, orgUrl: "https://org.example", token: "t" });
    const names = agent.state.tools.map((t) => t.name);
    expect(names).toContain("guide_highlight");
    expect(names).toContain("guide_sequence");
  });
});
