import { execFile } from "node:child_process";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

/** A single bash command runner for local system tasks. */
export function createBashTool(): AgentTool[] {
  const runBash: AgentTool = {
    name: "bash",
    label: "Run shell command",
    description:
      "Run a bash command on this machine as the desktop user and return its stdout and stderr. Use it for local tasks: reading or editing files, checking services (systemctl), launching desktop apps, installing packages the user asks for, inspecting hardware. Prefer the org tools for organisation data and the compositor tools for driving the headless workspace. Commands are capped at two minutes.",
    parameters: Type.Object({
      command: Type.String({ description: "The bash command line to run." }),
      timeout_ms: Type.Optional(
        Type.Number({ description: "Kill the command after this many milliseconds (1000-120000, default 30000)." }),
      ),
    }),
    execute: async (
      _toolCallId,
      params: { command: string; timeout_ms?: number },
    ) => {
      const timeoutMs = Math.min(Math.max(params.timeout_ms ?? 30_000, 1_000), 120_000);
      const result = await new Promise<{ code: number; stdout: string; stderr: string; killed: boolean }>(
        (resolve) => {
          execFile(
            "/bin/bash",
            ["-lc", params.command],
            { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
            (err, stdout, stderr) => {
              const code = err && typeof (err as { code?: number }).code === "number"
                ? ((err as { code?: number }).code as number)
                : err
                  ? 1
                  : 0;
              resolve({
                code,
                stdout: String(stdout ?? ""),
                stderr: String(stderr ?? ""),
                killed: Boolean(err && (err as { killed?: boolean }).killed),
              });
            },
          );
        },
      );
      const parts = [`exit ${result.code}${result.killed ? " (timed out)" : ""}`];
      if (result.stdout.trim()) parts.push("--- stdout ---", result.stdout.trim().slice(0, 8000));
      if (result.stderr.trim()) parts.push("--- stderr ---", result.stderr.trim().slice(0, 4000));
      return {
        content: [{ type: "text" as const, text: parts.join("\n") }],
        details: { exit: result.code },
      };
    },
  };
  return [runBash];
}
