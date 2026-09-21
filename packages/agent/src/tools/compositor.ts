import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { connect as connectSocket, type Socket } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Tools for driving the headless agent workspace compositor (the
 * `staka-compositor` Rust driver). Communication is a local Unix socket with
 * length-prefixed frames:
 *
 *   [1 byte type][4 bytes big-endian payload length][payload]
 *   'J' (0x4A): UTF-8 JSON control message
 *   'B' (0x42): raw bytes (a PNG screenshot)
 *
 * Requests are `{"id": N, "cmd": "<name>", "args": {...}}`; responses echo
 * the id. A screenshot response carries `data.binary: true` and is followed
 * by exactly one 'B' frame with the PNG bytes.
 *
 * When the driver socket is absent (driver not started, or not in a Hyprland
 * session) the tools return a clear text message instead of throwing, so a
 * missing driver degrades the chat rather than breaking it.
 */

const FRAME_TYPE_JSON = 0x4a; // 'J'
const FRAME_TYPE_BINARY = 0x42; // 'B'

/// Screenshots are the only large payloads; matches the driver's own cap.
const MAX_FRAME_LEN = 32 * 1024 * 1024;

/// The driver's slowest commands (create_workspace launches a nested
/// compositor and waits for its window) need well under this.
const DEFAULT_TIMEOUT_MS = 20_000;

export const DEFAULT_SCREENSHOT_DIR = join(tmpdir(), "staka-compositor");

export function defaultCompositorSocketPath(): string {
  const runtimeDir = process.env.XDG_RUNTIME_DIR ?? "/tmp";
  return join(runtimeDir, "staka", "compositor.sock");
}

/// Apps the agent may launch in the headless workspace, as a fixed
/// allowlist. Keys are what the model picks; values are the driver
/// command lines.
const APP_ALLOWLIST = {
  terminal: "foot",
  calculator: "gnome-calculator",
  spreadsheet: "libreoffice --calc",
  writer: "libreoffice --writer",
} as const;

type AppName = keyof typeof APP_ALLOWLIST;

type DriverResponse = {
  id: number;
  ok: boolean;
  error?: string;
  data?: Record<string, unknown>;
  binary?: Uint8Array;
};

type Frame = { type: number; payload: Uint8Array };

function encodeFrame(type: number, payload: Uint8Array): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

/// Incremental frame parser over raw socket chunks.
class FrameReader {
  private buffer: Buffer = Buffer.alloc(0);
  private queue: Frame[] = [];
  private failure: Error | null = null;
  private waiter: { resolve: (frame: Frame) => void; reject: (err: Error) => void } | null = null;

  push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 5) return;
      const type = this.buffer.readUInt8(0);
      const len = this.buffer.readUInt32BE(1);
      if (type !== FRAME_TYPE_JSON && type !== FRAME_TYPE_BINARY) {
        this.fail(new Error(`unknown frame type 0x${type.toString(16)}`));
        return;
      }
      if (len > MAX_FRAME_LEN) {
        this.fail(new Error(`frame length ${len} exceeds limit ${MAX_FRAME_LEN}`));
        return;
      }
      if (this.buffer.length < 5 + len) return;
      const payload = new Uint8Array(this.buffer.subarray(5, 5 + len));
      this.buffer = this.buffer.subarray(5 + len);
      const frame = { type, payload };
      const waiter = this.waiter;
      if (waiter) {
        this.waiter = null;
        waiter.resolve(frame);
      } else {
        this.queue.push(frame);
      }
    }
  }

  fail(err: Error): void {
    this.failure = err;
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter.reject(err);
    }
  }

  next(): Promise<Frame> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function connectUnix(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connectSocket(path);
    socket.once("connect", () => resolve(socket));
    socket.once("error", (err) => reject(err));
  });
}

/// Sends one command and collects its response (plus the binary frame for
/// screenshots). One connection per call: the driver spawns a thread per
/// connection and this keeps the client stateless.
export async function callCompositor(
  socketPath: string,
  cmd: string,
  args: Record<string, unknown> = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<DriverResponse> {
  let socket: Socket;
  try {
    socket = await connectUnix(socketPath);
  } catch {
    throw new DriverUnavailableError(socketPath);
  }

  const reader = new FrameReader();
  socket.on("data", (chunk: Buffer) => reader.push(chunk));
  const failure = (err: Error) => reader.fail(err);
  socket.on("error", failure);
  socket.on("close", () => {
    if (!reader.failure) reader.fail(new Error("connection closed before a response arrived"));
  });

  try {
    const id = nextRequestId();
    socket.write(encodeFrame(FRAME_TYPE_JSON, Buffer.from(JSON.stringify({ id, cmd, args }))));

    const jsonFrame = await withTimeout(reader.next(), timeoutMs, `${cmd} response`);
    const response = JSON.parse(new TextDecoder().decode(jsonFrame.payload)) as DriverResponse;
    if (jsonFrame.type !== FRAME_TYPE_JSON) {
      throw new Error("expected a JSON response frame");
    }

    if (response.data?.["binary"] === true) {
      const binFrame = await withTimeout(reader.next(), timeoutMs, `${cmd} binary payload`);
      if (binFrame.type !== FRAME_TYPE_BINARY) {
        throw new Error("expected a binary frame after a binary response");
      }
      return { ...response, binary: binFrame.payload };
    }
    return response;
  } finally {
    socket.destroy();
  }
}

let requestIdCounter = 0;

function nextRequestId(): number {
  requestIdCounter += 1;
  return requestIdCounter;
}

export class DriverUnavailableError extends Error {
  constructor(socketPath: string) {
    super(`compositor driver not available at ${socketPath}`);
    this.name = "DriverUnavailableError";
  }
}

function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: {},
  };
}

function isConnectRefusal(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ECONNREFUSED" || code === "EACCES";
}

export type CompositorToolsDeps = {
  /// Unix socket path of the staka-compositor driver. Defaults to
  /// $XDG_RUNTIME_DIR/staka/compositor.sock.
  socketPath?: string;
  /// Directory screenshots are written to. Defaults to the system temp dir.
  screenshotDir?: string;
};

export function createCompositorTools(deps: CompositorToolsDeps = {}): AgentTool[] {
  const socketPath = deps.socketPath ?? defaultCompositorSocketPath();
  const screenshotDir = deps.screenshotDir ?? DEFAULT_SCREENSHOT_DIR;

  /// Tool bodies catch connection failures and report them as plain text,
  /// so a missing driver degrades the conversation instead of erroring it.
  async function run(cmd: string, args: Record<string, unknown>): Promise<DriverResponse> {
    return callCompositor(socketPath, cmd, args);
  }

  function unavailableText(err: unknown): string | null {
    if (err instanceof DriverUnavailableError) {
      return `${err.message}. Start the driver with "staka-compositor" from inside the Hyprland session.`;
    }
    if (isConnectRefusal(err)) {
      return `compositor driver not available at ${socketPath}. Start the driver with "staka-compositor" from inside the Hyprland session.`;
    }
    return null;
  }

  const status: AgentTool = {
    name: "compositor_status",
    label: "Compositor status",
    description:
      "Check whether the headless workspace compositor driver is running and whether it can reach Hyprland.",
    parameters: Type.Object({}),
    execute: async () => {
      try {
        const res = await run("health", {});
        if (!res.ok) return textResult(`compositor driver reachable but unhealthy: ${res.error}`);
        return textResult("compositor driver is running and Hyprland is reachable");
      } catch (err) {
        const unavailable = unavailableText(err);
        if (unavailable) return textResult(unavailable);
        throw err;
      }
    },
  };

  const startApp: AgentTool = {
    name: "compositor_start_app",
    label: "Compositor start app",
    description:
      "Start an app in an isolated headless agent workspace (invisible output, separate input seat; the user's display is untouched). " +
      `app must be one of: ${Object.keys(APP_ALLOWLIST).join(", ")}.`,
    parameters: Type.Object({
      app: Type.Union(
        Object.keys(APP_ALLOWLIST).map((name) => Type.Literal(name)),
        { description: "Which app to launch in the headless workspace." },
      ),
    }),
    execute: async (_toolCallId, params: { app: AppName }) => {
      const command = APP_ALLOWLIST[params.app];
      try {
        const res = await run("create_workspace", { app: command });
        if (!res.ok) return textResult(`compositor_start_app failed: ${res.error}`);
        const data = res.data ?? {};
        return textResult(
          `Started ${params.app} (${command}) in the headless agent workspace ` +
            `${data.workspace ?? "?"} on output ${data.output ?? "?"}.`,
        );
      } catch (err) {
        const unavailable = unavailableText(err);
        if (unavailable) return textResult(unavailable);
        throw err;
      }
    },
  };

  const click: AgentTool = {
    name: "compositor_click",
    label: "Compositor click",
    description:
      "Click at pixel coordinates inside the headless agent workspace. Coordinates are relative to the last compositor_screenshot image.",
    parameters: Type.Object({
      x: Type.Integer({ description: "Pixel x coordinate from the screenshot." }),
      y: Type.Integer({ description: "Pixel y coordinate from the screenshot." }),
      button: Type.Optional(
        Type.Union(
          [Type.Literal("left"), Type.Literal("middle"), Type.Literal("right")],
          { description: "Mouse button; defaults to left." },
        ),
      ),
    }),
    execute: async (_toolCallId, params: { x: number; y: number; button?: string }) => {
      try {
        const res = await run("click", {
          x: params.x,
          y: params.y,
          ...(params.button ? { button: params.button } : {}),
        });
        if (!res.ok) return textResult(`compositor_click failed: ${res.error}`);
        return textResult(`Clicked ${params.button ?? "left"} at (${params.x}, ${params.y}).`);
      } catch (err) {
        const unavailable = unavailableText(err);
        if (unavailable) return textResult(unavailable);
        throw err;
      }
    },
  };

  const type: AgentTool = {
    name: "compositor_type",
    label: "Compositor type",
    description: "Type text into the app in the headless agent workspace.",
    parameters: Type.Object({
      text: Type.String({ description: "Text to type." }),
    }),
    execute: async (_toolCallId, params: { text: string }) => {
      try {
        const res = await run("type", { text: params.text });
        if (!res.ok) return textResult(`compositor_type failed: ${res.error}`);
        return textResult(`Typed ${params.text.length} characters.`);
      } catch (err) {
        const unavailable = unavailableText(err);
        if (unavailable) return textResult(unavailable);
        throw err;
      }
    },
  };

  const key: AgentTool = {
    name: "compositor_key",
    label: "Compositor key",
    description: 'Press a key chord in the headless agent workspace, e.g. ["ctrl", "s"].',
    parameters: Type.Object({
      keys: Type.Array(Type.String(), {
        description: "Key names in the chord, in modifier-first order.",
      }),
    }),
    execute: async (_toolCallId, params: { keys: string[] }) => {
      try {
        const res = await run("key", { keys: params.keys });
        if (!res.ok) return textResult(`compositor_key failed: ${res.error}`);
        return textResult(`Pressed ${params.keys.join("+")}.`);
      } catch (err) {
        const unavailable = unavailableText(err);
        if (unavailable) return textResult(unavailable);
        throw err;
      }
    },
  };

  const screenshot: AgentTool = {
    name: "compositor_screenshot",
    label: "Compositor screenshot",
    description:
      "Capture a PNG screenshot of the headless agent workspace and save it to a local file. " +
      "Returns the file path; use compositor_click coordinates against this image.",
    parameters: Type.Object({}),
    execute: async () => {
      try {
        const res = await run("screenshot", { format: "png" });
        if (!res.ok) return textResult(`compositor_screenshot failed: ${res.error}`);
        if (!res.binary) return textResult("compositor_screenshot failed: no image data returned");
        await mkdir(screenshotDir, { recursive: true });
        const path = join(screenshotDir, `staka-compositor-${Date.now()}.png`);
        await writeFile(path, res.binary);
        return textResult(
          `Captured a ${res.binary.length}-byte PNG of the headless workspace to ${path}.`,
        );
      } catch (err) {
        const unavailable = unavailableText(err);
        if (unavailable) return textResult(unavailable);
        throw err;
      }
    },
  };

  const teardown: AgentTool = {
    name: "compositor_teardown",
    label: "Compositor teardown",
    description:
      "Destroy the headless agent workspace: stop the app, remove the invisible output, and restore the user's layout.",
    parameters: Type.Object({}),
    execute: async () => {
      try {
        const res = await run("teardown", {});
        if (!res.ok) return textResult(`compositor_teardown failed: ${res.error}`);
        const data = res.data ?? {};
        const removed = Array.isArray(data.removed) ? data.removed.join(", ") : "";
        return textResult(removed ? `Tore down the headless workspace (removed ${removed}).` : "Tore down the headless workspace.");
      } catch (err) {
        const unavailable = unavailableText(err);
        if (unavailable) return textResult(unavailable);
        throw err;
      }
    },
  };

  return [status, startApp, click, type, key, screenshot, teardown];
}
