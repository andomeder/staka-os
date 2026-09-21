import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

/**
 * Tools for guiding the user on their own display: the Staka shell renders a
 * click-through overlay (fake cursor + highlight) at compositor-native
 * global coordinates while the user keeps working. The overlay never
 * intercepts input; see packages/shell/tests/guide-overlay-clickthrough.
 *
 * The agent drives the overlay through the shell's IPC bridge, the same
 * channel the Super+A panel uses:
 *
 *   qs -p <STAKA_SHELL_PATH>/shell ipc call -- guide highlight '<json>'
 *   qs -p <STAKA_SHELL_PATH>/shell ipc call -- guide sequence '<json>'
 *
 * When the shell is not running (headless session, SSH, CI) the tools
 * return a clear text message instead of throwing, so a missing shell
 * degrades the conversation rather than breaking it.
 */

export type GuideToolsDeps = {
  /// Directory containing shell.qml, i.e. the value passed to `qs -p`.
  /// Defaults to $STAKA_SHELL_PATH/shell, then /opt/staka/shell/shell.
  shellPath?: string;
  /// QuickShell CLI binary. Defaults to "qs".
  qsBin?: string;
  /// Injectable runner for tests: executes one argv and reports the result.
  run?: (argv: string[]) => Promise<RunResult>;
};

export type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

const IPC_TIMEOUT_MS = 3000;
const MAX_STEPS = 10;
const MIN_DURATION_MS = 500;
const MAX_DURATION_MS = 60000;
const MAX_LABEL_LEN = 80;

export function defaultGuideShellPath(): string {
  const root = process.env.STAKA_SHELL_PATH ?? "/opt/staka/shell";
  return `${root.replace(/\/+$/, "")}/shell`;
}

async function defaultRun(argv: string[]): Promise<RunResult> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), IPC_TIMEOUT_MS);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, stdout, stderr };
}

function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: {},
  };
}

/// Coordinate/label validation shared by both tools. Returns an error
/// message, or null when the step is usable.
function validateStep(step: unknown, index: number): string | null {
  if (step === null || typeof step !== "object") {
    return `steps[${index}] must be an object with x and y`;
  }
  const s = step as Record<string, unknown>;
  for (const key of ["x", "y"] as const) {
    const v = s[key];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      return `steps[${index}].${key} must be a number`;
    }
  }
  if (s.w !== undefined && (typeof s.w !== "number" || s.w < 8)) {
    return `steps[${index}].w must be a number >= 8`;
  }
  if (s.h !== undefined && (typeof s.h !== "number" || s.h < 8)) {
    return `steps[${index}].h must be a number >= 8`;
  }
  if (s.label !== undefined) {
    if (typeof s.label !== "string") return `steps[${index}].label must be a string`;
    if (s.label.length > MAX_LABEL_LEN) {
      return `steps[${index}].label must be at most ${MAX_LABEL_LEN} characters`;
    }
  }
  if (s.durationMs !== undefined) {
    const v = s.durationMs;
    if (typeof v !== "number" || v < MIN_DURATION_MS || v > MAX_DURATION_MS) {
      return `steps[${index}].durationMs must be between ${MIN_DURATION_MS} and ${MAX_DURATION_MS}`;
    }
  }
  return null;
}

function normalizeStep(step: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    x: Math.round(step.x as number),
    y: Math.round(step.y as number),
  };
  if (step.w !== undefined) out.w = Math.round(step.w as number);
  if (step.h !== undefined) out.h = Math.round(step.h as number);
  if (typeof step.label === "string" && step.label.length > 0) out.label = step.label;
  if (step.durationMs !== undefined) out.durationMs = Math.round(step.durationMs as number);
  return out;
}

function stepSummary(step: Record<string, unknown>): string {
  const label = typeof step.label === "string" && step.label.length > 0 ? ` (${step.label})` : "";
  return `(${step.x}, ${step.y}${step.w !== undefined ? ` ${step.w}x${step.h ?? 56}` : ""})${label}`;
}

export function createGuideTools(deps: GuideToolsDeps = {}): AgentTool[] {
  const shellPath = deps.shellPath ?? defaultGuideShellPath();
  const qsBin = deps.qsBin ?? "qs";
  const run = deps.run ?? defaultRun;

  /// Sends one IPC call to the shell. Returns a human-readable result.
  /// Both spawn failures and qs's stdout-level IPC failures (exit 0 with
  /// "Target not found." etc.) surface as graceful text.
  async function ipcCall(method: string, payload: unknown): Promise<string> {
    const argv = [
      qsBin,
      "-p",
      shellPath,
      "ipc",
      "call",
      "--",
      "guide",
      method,
      JSON.stringify(payload),
    ];
    let res: RunResult;
    try {
      res = await run(argv);
    } catch (err) {
      return `guide overlay unavailable: could not run ${qsBin} (${(err as Error).message}). The Staka shell must be running on the user's session.`;
    }
    const stdout = res.stdout.trim();
    if (res.code !== 0) {
      const detail = res.stderr.trim() || stdout || `exit ${res.code}`;
      return `guide overlay unavailable: ${detail}. The Staka shell must be running on the user's session.`;
    }
    if (/^(Target not found\.|Function not found\.)/.test(stdout)) {
      return `guide overlay unavailable: the running shell has no guide IPC target (shell too old or overlay service disabled).`;
    }
    return stdout;
  }

  const highlight: AgentTool = {
    name: "guide_highlight",
    label: "Guide highlight",
    description:
      "Point at a place on the user's screen: the shell overlay draws a highlight box, a fake agent cursor, and an optional label at global pixel coordinates. " +
      "The overlay is click-through and never interferes with the user's input. Coordinates come from structured reads (CDP/AT-SPI/window geometry), not screenshots.",
    parameters: Type.Object({
      x: Type.Integer({ description: "Global pixel x of the target." }),
      y: Type.Integer({ description: "Global pixel y of the target." }),
      w: Type.Optional(Type.Integer({ description: "Highlight width in pixels (default 160)." })),
      h: Type.Optional(Type.Integer({ description: "Highlight height in pixels (default 56)." })),
      label: Type.Optional(
        Type.String({ description: `Short label shown next to the cursor (max ${MAX_LABEL_LEN} chars), e.g. "File > Export".` }),
      ),
      durationMs: Type.Optional(
        Type.Integer({
          description: `How long the highlight stays visible (${MIN_DURATION_MS}-${MAX_DURATION_MS}ms; default 10000).`,
        }),
      ),
    }),
    execute: async (_toolCallId, params: Record<string, unknown>) => {
      const error = validateStep(params, 0);
      if (error) return textResult(`guide_highlight: ${error}`);
      const payload = normalizeStep(params);
      const result = await ipcCall("highlight", payload);
      if (result.startsWith("guide overlay unavailable")) return textResult(result);
      return textResult(`Highlighted target ${stepSummary(payload)} on the user's screen.`);
    },
  };

  const sequence: AgentTool = {
    name: "guide_sequence",
    label: "Guide sequence",
    description:
      "Walk the user through several places on their screen in order: the shell overlay moves the highlight, fake cursor, and label through each step, then dismisses. " +
      "Use for 'show me where that setting is' style walkthroughs. Coordinates are global pixels from structured reads.",
    parameters: Type.Object({
      steps: Type.Array(
        Type.Object({
          x: Type.Integer({ description: "Global pixel x of this step's target." }),
          y: Type.Integer({ description: "Global pixel y of this step's target." }),
          w: Type.Optional(Type.Integer({ description: "Highlight width in pixels (default 160)." })),
          h: Type.Optional(Type.Integer({ description: "Highlight height in pixels (default 56)." })),
          label: Type.Optional(
            Type.String({ description: `Short label for this step (max ${MAX_LABEL_LEN} chars).` }),
          ),
          durationMs: Type.Optional(
            Type.Integer({
              description: `How long this step stays visible (${MIN_DURATION_MS}-${MAX_DURATION_MS}ms; default 4000).`,
            }),
          ),
        }),
        { description: "The walkthrough steps, in order.", maxItems: MAX_STEPS },
      ),
    }),
    execute: async (_toolCallId, params: { steps: unknown[] }) => {
      const steps = Array.isArray(params.steps) ? params.steps : [];
      if (steps.length === 0) {
        return textResult("guide_sequence: steps must be a non-empty array");
      }
      if (steps.length > MAX_STEPS) {
        return textResult(`guide_sequence: at most ${MAX_STEPS} steps per sequence`);
      }
      for (let i = 0; i < steps.length; i++) {
        const error = validateStep(steps[i], i);
        if (error) return textResult(`guide_sequence: ${error}`);
      }
      const payload = { steps: steps.map((s) => normalizeStep(s as Record<string, unknown>)) };
      const result = await ipcCall("sequence", payload);
      if (result.startsWith("guide overlay unavailable")) return textResult(result);
      return textResult(`Started a guided sequence with ${payload.steps.length} steps.`);
    },
  };

  return [highlight, sequence];
}
