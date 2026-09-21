/**
 * Chromium target discovery: reading the DevToolsActivePort file that
 * Chromium writes into its --user-data-dir when launched with
 * --remote-debugging-port=0, and enumerating targets over the loopback
 * HTTP endpoint (/json/list).
 */

export type TargetInfo = {
  id: string;
  type: string;
  url: string;
  title: string;
  webSocketDebuggerUrl: string | null;
};

/// Reads the port from <profileDir>/DevToolsActivePort (first line).
/// Returns null when the file is absent or unreadable.
export function readDevToolsPort(
  profileDir: string,
  readFile: (path: string) => Promise<string>,
): Promise<number | null> {
  return readFile(`${profileDir}/DevToolsActivePort`).then(
    (text) => {
      const line = text.split("\n")[0]?.trim();
      const port = line ? Number.parseInt(line, 10) : Number.NaN;
      return Number.isInteger(port) && port > 0 && port < 65_536 ? port : null;
    },
    () => null,
  );
}

/// Enumerates targets from the browser's HTTP endpoint. Prefer fetch
/// injection in tests; the default is the global fetch restricted to
/// loopback callers pass the URL for.
export async function listTargets(
  httpPort: number,
  doFetch: typeof fetch = fetch,
): Promise<TargetInfo[]> {
  let res: Response;
  try {
    res = await doFetch(`http://127.0.0.1:${httpPort}/json/list`);
  } catch {
    return [];
  }
  if (!res.ok) return [];
  const body = (await res.json()) as Array<Record<string, unknown>>;
  return body
    .filter((t) => typeof t.id === "string" && typeof t.type === "string")
    .map((t) => ({
      id: t.id as string,
      type: t.type as string,
      url: typeof t.url === "string" ? t.url : "",
      title: typeof t.title === "string" ? t.title : "",
      webSocketDebuggerUrl:
        typeof t.webSocketDebuggerUrl === "string"
          ? t.webSocketDebuggerUrl
          : null,
    }));
}

/// Returns the page targets (type === "page"), newest launch order first.
export function pageTargets(targets: TargetInfo[]): TargetInfo[] {
  return targets.filter((t) => t.type === "page");
}
