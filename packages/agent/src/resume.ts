/**
 * Suspend/resume recovery for the headless agent workspace.
 *
 * The login manager broadcasts PrepareForSleep(true) before the machine
 * suspends and PrepareForSleep(false) after it resumes. A suspend can kill
 * the nested cage compositor or make Hyprland drop the headless output, so
 * on resume the agent probes the driver's health and rebuilds the
 * workspace if the probe reports a dead cage or a missing output.
 *
 * The DBus stream comes from `gdbus monitor --system` (glib ships it on
 * every Staka system). If gdbus is missing or the stream dies, the watcher
 * gives up quietly: the workspace tools still report their own honest
 * "driver not available" text when something is wrong.
 */

import { spawn } from "node:child_process";
import { callCompositor, defaultCompositorSocketPath, type DriverResponse } from "./tools/compositor.ts";

export type SleepPhase = "sleep" | "resume";

/**
 * Extracts the sleep phase from one `gdbus monitor` line. Signal lines
 * look like:
 *
 *   /org/freedesktop/login1: org.freedesktop.login1.Manager PrepareForSleep (true)
 */
export function parseSleepLine(line: string): SleepPhase | null {
  const match = line.match(/PrepareForSleep\s*\((true|false)\)/);
  if (!match) return null;
  return match[1] === "true" ? "sleep" : "resume";
}

export type CompositorHealth = {
  ok: boolean;
  error?: string;
  data?: { session?: Record<string, unknown> | null };
};

export type RecoveryAction = {
  /// What the recovery decided; null when nothing needed doing.
  action: "healthy" | "no_session" | "teardown_failed" | "recreated" | "recreate_failed";
  detail: string;
};

/**
 * Decides and performs resume recovery from one health response. A session
 * is degraded when its cage died or its headless output disappeared; the
 * workspace is torn down and recreated with the same app. Injection point
 * `call` keeps this testable without a driver.
 */
export async function recoverOnResume(
  call: (cmd: string, args?: Record<string, unknown>) => Promise<DriverResponse>,
): Promise<RecoveryAction> {
  const health = await call("health").catch((err: unknown) => ({
    id: 0,
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  })) as DriverResponse;

  const session = (health.data?.["session"] ?? null) as Record<string, unknown> | null;
  if (!health.ok || !session || session["active"] !== true) {
    return { action: "no_session", detail: "no active headless workspace to recover" };
  }

  const cageAlive = session["cage_alive"] === true;
  const outputPresent = session["output_present"] === true;
  if (cageAlive && outputPresent) {
    return { action: "healthy", detail: "headless workspace survived the suspend" };
  }

  const broken = [
    ...(cageAlive ? [] : ["the nested compositor died"]),
    ...(outputPresent ? [] : ["the headless output disappeared"]),
  ].join(" and ");

  const teardown = await call("teardown").catch((err: unknown) => ({
    id: 0,
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  })) as DriverResponse;
  if (!teardown.ok) {
    return {
      action: "teardown_failed",
      detail: `workspace was degraded (${broken}) and teardown failed: ${teardown.error}`,
    };
  }

  const app = typeof session["app"] === "string" && session["app"] !== "" ? session["app"] : null;
  const create = await call("create_workspace", app ? { app } : {}).catch((err: unknown) => ({
    id: 0,
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  })) as DriverResponse;
  if (!create.ok) {
    return {
      action: "recreate_failed",
      detail: `teardown after a degraded workspace (${broken}) succeeded but recreation failed: ${create.error}`,
    };
  }

  const data = create.data ?? {};
  return {
    action: "recreated",
    detail: `recreated the headless workspace (${broken}): output ${data["output"] ?? "?"}, workspace ${data["workspace"] ?? "?"}${app ? `, app ${app}` : ""}`,
  };
}

export type ResumeWatcherDeps = {
  /// Driver socket path; defaults to the compositor tools default.
  socketPath?: string;
  /// Extra delay after resume before probing, so the desktop can settle.
  resumeSettleMs?: number;
  /// Log sink (stderr by default).
  log?: (message: string) => void;
  /// Watch-process launcher; injectable for tests.
  spawnMonitor?: typeof spawn;
};

/**
 * Watches login1 for sleep events and recovers the headless workspace on
 * resume. Returns a stop function. Never throws: failures to even start
 * the monitor are reported through the log sink.
 */
export function startResumeWatcher(deps: ResumeWatcherDeps = {}): { stop: () => void } {
  const log = deps.log ?? ((message: string) => console.error(message));
  const socketPath = deps.socketPath ?? defaultCompositorSocketPath();
  const settleMs = deps.resumeSettleMs ?? 2_000;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let child: ReturnType<typeof spawn> | null = null;

  async function recoverAfterResume(): Promise<void> {
    try {
      const result = await recoverOnResume((cmd, args) =>
        callCompositor(socketPath, cmd, args),
      );
      log(`resume recovery: ${result.action} - ${result.detail}`);
    } catch (err) {
      log(`resume recovery failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  try {
    child = (deps.spawnMonitor ?? spawn)("gdbus", [
      "monitor",
      "--system",
      "--dest",
      "org.freedesktop.login1",
      "--object-path",
      "/org/freedesktop/login1",
    ], { stdio: ["ignore", "pipe", "ignore"] });
  } catch (err) {
    log(`resume watcher unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return { stop: () => {} };
  }

  let buffer = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (stopped) return;
      if (parseSleepLine(line) === "sleep") {
        log("system going to sleep; headless workspace marked at risk");
      } else if (parseSleepLine(line) === "resume") {
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
          void recoverAfterResume();
        }, settleMs);
      }
    }
  });
  child.on("error", (err: Error) => {
    // spawn() emits async errors (ENOENT for gdbus) here.
    log(`resume watcher unavailable: ${err.message}`);
  });

  return {
    stop() {
      stopped = true;
      if (settleTimer) clearTimeout(settleTimer);
      child?.kill();
    },
  };
}
