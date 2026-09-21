import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { readFile } from "node:fs/promises";

/**
 * fs_read_file: read-only, sandboxed local file access for the agent.
 *
 * Guardrails:
 * - Only paths under the configured allowlist directories are readable
 *   (realpath-checked, so symlink and `..` traversal cannot escape).
 * - 2 MiB size cap.
 * - Every read attempt - allowed or denied - is audit-logged to the org
 *   server as an `agent_file_read` usage event with the path and size,
 *   never the contents.
 */

export const MAX_READ_BYTES = 2 * 1024 * 1024;

export type FsToolsDeps = {
  allowlist: string[];
  orgUrl: string;
  token: string;
  fetch?: typeof fetch;
  maxBytes?: number;
  /// Expand ~ in allowlist entries (overridable in tests).
  homeDir?: string;
};

export type AllowlistCheck =
  | { ok: true; path: string }
  | { ok: false; reason: string };

/// Resolves user shorthand (~, ~/x) against the home dir.
export function expandPath(path: string, homeDir: string): string {
  if (path === "~") return homeDir;
  if (path.startsWith("~/")) return join(homeDir, path.slice(2));
  return path;
}

/// Decides whether a requested path may be read. The allowlist is a set of
/// directories (files allowed too); the requested path must resolve inside
/// one of them after symlink resolution.
export async function checkAllowlist(
  requestedPath: string,
  allowlist: string[],
  homeDir: string,
): Promise<AllowlistCheck> {
  if (allowlist.length === 0) {
    return {
      ok: false,
      reason: "no allowlist is configured (set STAKA_FS_ALLOWLIST on the agent)",
    };
  }
  const expanded = expandPath(requestedPath, homeDir);
  if (!isAbsolute(expanded)) {
    return { ok: false, reason: "path must be absolute" };
  }
  let target: string;
  try {
    target = await realpath(resolve(expanded));
  } catch {
    return { ok: false, reason: "path does not exist" };
  }
  for (const entry of allowlist) {
    let root: string;
    try {
      root = await realpath(resolve(expandPath(entry, homeDir)));
    } catch {
      continue; // allowlist entry missing on disk cannot authorize anything
    }
    if (target === root || target.startsWith(root + "/")) {
      return { ok: true, path: target };
    }
  }
  return { ok: false, reason: "path is outside the read allowlist" };
}

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: {},
  };
}

export function createFsTools(deps: FsToolsDeps): AgentTool[] {
  const doFetch = deps.fetch ?? fetch;
  const base = deps.orgUrl.replace(/\/$/, "");
  const maxBytes = deps.maxBytes ?? MAX_READ_BYTES;

  async function audit(entry: {
    path: string;
    size: number | null;
    denied: boolean;
    reason?: string;
  }): Promise<boolean> {
    try {
      const res = await doFetch(`${base}/v1/usage-logs`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${deps.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          event_type: "agent_file_read",
          detail: {
            path: entry.path,
            size: entry.size,
            denied: entry.denied,
            ...(entry.reason ? { reason: entry.reason } : {}),
          },
        }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  const readFileTool: AgentTool = {
    name: "fs_read_file",
    label: "FS read file",
    description:
      "Read a UTF-8 text file from an allowlisted directory (configured by the org, read-only, 2 MiB cap, every attempt audit-logged). " +
      "Paths outside the allowlist are denied and audited.",
    parameters: Type.Object({
      path: Type.String({ description: "Absolute path (or ~/...) to read." }),
    }),
    execute: async (_toolCallId, params: { path: string }) => {
      const homeDir = deps.homeDir ?? homedir();
      const checked = await checkAllowlist(params.path, deps.allowlist, homeDir);
      if (!checked.ok) {
        const audited = await audit({
          path: params.path,
          size: null,
          denied: true,
          reason: checked.reason,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `path_denied: cannot read ${params.path} - ${checked.reason}.` +
                (audited ? "" : " (audit delivery failed)"),
            },
          ],
          details: {},
        };
      }

      const info = await stat(checked.path).catch(() => null);
      if (!info?.isFile()) {
        return {
          content: [
            {
              type: "text" as const,
              text: `fs_read_file failed: ${checked.path} is not a regular file.`,
            },
          ],
          details: {},
        };
      }
      if (info.size > maxBytes) {
        const audited = await audit({
          path: checked.path,
          size: info.size,
          denied: true,
          reason: "file exceeds the size cap",
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `path_denied: ${checked.path} is ${info.size} bytes, over the ${maxBytes}-byte cap.` +
                (audited ? "" : " (audit delivery failed)"),
            },
          ],
          details: {},
        };
      }

      const content = await readFile(checked.path, "utf8");
      const audited = await audit({
        path: checked.path,
        size: info.size,
        denied: false,
      });
      return jsonResult({
        path: checked.path,
        size: info.size,
        content,
        ...(audited ? {} : { audit_delivery_failed: true }),
      });
    },
  };

  return [readFileTool];
}
