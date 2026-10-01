import { describe, expect, test } from "bun:test";
import {
  parseSleepLine,
  recoverOnResume,
  type RecoveryAction,
} from "../src/resume.ts";
import type { DriverResponse } from "../src/tools/compositor.ts";

function ok(data?: Record<string, unknown>): DriverResponse {
  return { id: 1, ok: true, data };
}

function fail(error: string): DriverResponse {
  return { id: 1, ok: false, error };
}

describe("parseSleepLine", () => {
  test("reads gdbus monitor signal lines", () => {
    const line =
      "/org/freedesktop/login1: org.freedesktop.login1.Manager PrepareForSleep (true)";
    expect(parseSleepLine(line)).toBe("sleep");
  });

  test("distinguishes resume from sleep", () => {
    const line =
      "/org/freedesktop/login1: org.freedesktop.login1.Manager PrepareForSleep (false)";
    expect(parseSleepLine(line)).toBe("resume");
  });

  test("ignores unrelated login1 signals", () => {
    expect(
      parseSleepLine(
        "/org/freedesktop/login1: org.freedesktop.login1.Manager PrepareForShutdown (true)",
      ),
    ).toBeNull();
    expect(parseSleepLine("garbage")).toBeNull();
    expect(parseSleepLine("")).toBeNull();
  });
});

describe("recoverOnResume", () => {
  type Call = { cmd: string; args?: Record<string, unknown> };

  function driver(responses: Record<string, DriverResponse>) {
    const calls: Call[] = [];
    const call = async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      const response = responses[cmd];
      if (!response) throw new Error(`no scripted response for ${cmd}`);
      return response;
    };
    return { calls, call };
  }

  function sessionData(state: {
    cage_alive: boolean;
    output_present: boolean;
    app?: string | null;
  }) {
    return {
      session: {
        active: true,
        cage_alive: state.cage_alive,
        output_present: state.output_present,
        output: "HEADLESS-2",
        workspace: "staka-agent-1",
        app: state.app === undefined ? "gnome-calculator" : state.app,
      },
    };
  }

  test("does nothing when there is no active workspace", async () => {
    const driverFake = driver({ health: ok({ hyprland: true, session: null }) });
    const result = await recoverOnResume(driverFake.call);
    expect(result.action).toBe("no_session");
    expect(driverFake.calls.map((c) => c.cmd)).toEqual(["health"]);
  });

  test("does nothing when the workspace survived the suspend", async () => {
    const driverFake = driver({
      health: ok({ hyprland: true, ...sessionData({ cage_alive: true, output_present: true }) }),
    });
    const result = await recoverOnResume(driverFake.call);
    expect(result.action).toBe("healthy");
    expect(driverFake.calls.map((c) => c.cmd)).toEqual(["health"]);
  });

  test("treats a driver error as no session", async () => {
    const driverFake = driver({});
    const result = await recoverOnResume(driverFake.call);
    expect(result.action).toBe("no_session");
  });

  test("tears down and recreates the same app when the cage died", async () => {
    const driverFake = driver({
      health: ok({ hyprland: true, ...sessionData({ cage_alive: false, output_present: true }) }),
      teardown: ok({ removed: ["HEADLESS-2"] }),
      create_workspace: ok({ output: "HEADLESS-3", workspace: "staka-agent-2" }),
    });
    const result = await recoverOnResume(driverFake.call);
    expect(result.action).toBe("recreated");
    expect(driverFake.calls.map((c) => c.cmd)).toEqual(["health", "teardown", "create_workspace"]);
    expect(driverFake.calls[2]!.args).toEqual({ app: "gnome-calculator" });
    expect(result.detail).toContain("compositor died");
    expect(result.detail).toContain("HEADLESS-3");
  });

  test("recreates a bare workspace when only the output disappeared", async () => {
    const driverFake = driver({
      health: ok({
        hyprland: true,
        ...sessionData({ cage_alive: true, output_present: false, app: null }),
      }),
      teardown: ok({ removed: ["HEADLESS-2"] }),
      create_workspace: ok({ output: "HEADLESS-3", workspace: "staka-agent-2" }),
    });
    const result = await recoverOnResume(driverFake.call);
    expect(result.action).toBe("recreated");
    expect(driverFake.calls[2]!.args).toEqual({});
  });

  test("reports a failed teardown and does not recreate", async () => {
    const driverFake = driver({
      health: ok({ hyprland: true, ...sessionData({ cage_alive: false, output_present: false }) }),
      teardown: fail("hyprctl exploded"),
    });
    const result: RecoveryAction = await recoverOnResume(driverFake.call);
    expect(result.action).toBe("teardown_failed");
    expect(driverFake.calls.map((c) => c.cmd)).toEqual(["health", "teardown"]);
  });

  test("reports a failed recreation after a successful teardown", async () => {
    const driverFake = driver({
      health: ok({ hyprland: true, ...sessionData({ cage_alive: false, output_present: false }) }),
      teardown: ok({ removed: ["HEADLESS-2"] }),
      create_workspace: fail("cage missing"),
    });
    const result = await recoverOnResume(driverFake.call);
    expect(result.action).toBe("recreate_failed");
    expect(result.detail).toContain("cage missing");
  });
});
