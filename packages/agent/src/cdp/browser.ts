/**
 * Staka-managed Chromium lifecycle.
 *
 * The agent never attaches to the user's personal browser. It launches
 * Chromium in app mode with a dedicated profile directory under
 * $XDG_DATA_HOME/staka/browser and an ephemeral debugging port
 * (--remote-debugging-port=0). Chromium then writes the chosen port into
 * <profileDir>/DevToolsActivePort, which is how we find it again and reuse
 * a live instance instead of spawning a second one.
 */

import { readFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { listTargets, readDevToolsPort, type TargetInfo } from "./targets.ts";

export type BrowserHandle = {
  /// Loopback HTTP port of the DevTools endpoint.
  httpPort: number;
  /// Targets currently open (populated from /json/list).
  targets: TargetInfo[];
  /// True when this call spawned the browser, false when an existing
  /// instance was reused.
  launched: boolean;
};

export type EnsureBrowserOptions = {
  profileDir?: string;
  chromiumBin?: string;
  /// App-mode URL passed at launch (only used when a launch happens).
  url?: string;
  /// Run headless (used by tests and CI; the demo runs headed).
  headless?: boolean;
  doFetch?: typeof fetch;
  spawnProcess?: typeof spawn;
  launchTimeoutMs?: number;
};

/// Default profile dir: $XDG_DATA_HOME/staka/browser (or ~/.local/share/...).
export function defaultProfileDir(): string {
  const dataHome =
    process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(dataHome, "staka", "browser");
}

/// The launch flags. Everything about the security posture is in here:
/// dedicated profile dir, ephemeral loopback-only debug port, no first-run
/// wizard, app mode for the demo dashboard.
export function launchArgs(profileDir: string, url?: string): string[] {
  const args = [
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
  ];
  if (url) args.push(`--app=${url}`);
  return args;
}

async function probe(
  profileDir: string,
  doFetch: typeof fetch,
): Promise<{ httpPort: number; targets: TargetInfo[] } | null> {
  const port = await readDevToolsPort(profileDir, (path) =>
    readFile(path, "utf8"),
  );
  if (port === null) return null;
  const targets = await listTargets(port, doFetch);
  // /json/list answering with an empty body is still a live browser; but
  // a fetch failure already yields []. Treat any successful listing as
  // proof of life.
  const reachable = await (async () => {
    try {
      const res = await doFetch(`http://127.0.0.1:${port}/json/version`);
      return res.ok;
    } catch {
      return false;
    }
  })();
  if (!reachable) return null;
  return { httpPort: port, targets };
}

async function launchAndWait(
  profileDir: string,
  opts: EnsureBrowserOptions,
): Promise<void> {
  const bin = opts.chromiumBin ?? process.env.STAKA_CHROMIUM_BIN ?? "chromium";
  await mkdir(profileDir, { recursive: true });
  const args = launchArgs(profileDir, opts.url);
  if (opts.headless) args.push("--headless=new");
  const spawnFn = opts.spawnProcess ?? spawn;
  const child = spawnFn(bin, args, {
    stdio: "ignore",
    detached: true,
  });
  child.unref?.();

  const deadline = Date.now() + (opts.launchTimeoutMs ?? 10_000);
  for (;;) {
    const found = await probe(profileDir, opts.doFetch ?? fetch);
    if (found) return;
    if (Date.now() > deadline) {
      throw new Error(
        `Chromium did not open a DevTools port within ${opts.launchTimeoutMs ?? 10_000}ms`,
      );
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

/// Returns a live browser handle: reuses the running Staka-managed instance
/// when its DevToolsActivePort is still valid, otherwise launches one.
export async function ensureBrowser(
  opts: EnsureBrowserOptions = {},
): Promise<BrowserHandle> {
  const profileDir = opts.profileDir ?? defaultProfileDir();
  const doFetch = opts.doFetch ?? fetch;

  const existing = await probe(profileDir, doFetch);
  if (existing) return { ...existing, launched: false };

  await launchAndWait(profileDir, { ...opts, profileDir, doFetch });
  const fresh = await probe(profileDir, doFetch);
  if (!fresh) throw new Error("Chromium launched but is not reachable");
  return { ...fresh, launched: true };
}
