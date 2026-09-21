import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCompositorTools, callCompositor } from "../src/tools/compositor.ts";
import { createAgent } from "../src/agent-factory.ts";
import type { Env } from "../src/env.ts";

const FRAME_TYPE_JSON = 0x4a;
const FRAME_TYPE_BINARY = 0x42;

function encodeFrame(type: number, payload: Uint8Array): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

type Request = { id: number; cmd: string; args: Record<string, unknown> };

type Responder = {
  json: (body: Record<string, unknown>) => void;
  binary: (bytes: Uint8Array) => void;
};

/// Mock driver: a Unix socket server that decodes one request frame per
/// connection and hands the parsed request to `handler`.
function startMockDriver(
  socketPath: string,
  handler: (req: Request, res: Responder) => void | Promise<void>,
): Promise<Server> {
  const server = createServer((socket: Socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 5) return;
      const len = buffer.readUInt32BE(1);
      if (buffer.length < 5 + len) return;
      const payload = buffer.subarray(5, 5 + len);
      buffer = buffer.subarray(5 + len);
      const req = JSON.parse(payload.toString("utf8")) as Request;
      const respond = (type: number, body: Uint8Array) => socket.write(encodeFrame(type, body));
      void handler(req, {
        json: (body) => respond(FRAME_TYPE_JSON, Buffer.from(JSON.stringify(body))),
        binary: (bytes) => respond(FRAME_TYPE_BINARY, bytes),
      });
    });
  });
  return new Promise((resolve) => server.listen(socketPath, () => resolve(server)));
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content[0].text ?? "";
}

function toolByName(tools: { name: string }[], name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`missing tool: ${name}`);
  return tool;
}

describe("compositor frame client", () => {
  const socketPath = join(tmpdir(), `staka-compositor-test-${process.pid}.sock`);
  let server: Server;

  beforeAll(async () => {
    server = await startMockDriver(socketPath, (req, res) => {
      if (req.cmd === "health") {
        res.json({ id: req.id, ok: true, data: { hyprland: true } });
        return;
      }
      if (req.cmd === "screenshot") {
        res.json({ id: req.id, ok: true, data: { binary: true } });
        res.binary(PNG_BYTES);
        return;
      }
      if (req.cmd === "explode") {
        res.json({ id: req.id, ok: false, error: "headless output create failed" });
        return;
      }
      res.json({ id: req.id, ok: true });
    });
  });

  afterAll(() => {
    server.close();
    rm(socketPath, { force: true });
  });

  test("sends a JSON request frame and parses the JSON response", async () => {
    const res = await callCompositor(socketPath, "health", {}, 5000);
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ hyprland: true });
  });

  test("collects the binary frame that follows a binary response", async () => {
    const res = await callCompositor(socketPath, "screenshot", { format: "png" }, 5000);
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ binary: true });
    expect(res.binary).toEqual(PNG_BYTES);
  });

  test("surfaces driver error responses", async () => {
    const res = await callCompositor(socketPath, "explode", {}, 5000);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("headless output create failed");
  });

  test("reassembles frames delivered in partial socket writes", async () => {
    // A dedicated server that splits the reply into three writes with a
    // pause in the middle of the frame, exercising the parser's buffering.
    const splitPath = join(tmpdir(), `staka-compositor-split-${process.pid}.sock`);
    const splitServer = createServer((socket: Socket) => {
      socket.on("data", () => {
        const body = JSON.stringify({ id: 1, ok: true, data: { hyprland: true } });
        const frame = encodeFrame(FRAME_TYPE_JSON, Buffer.from(body));
        socket.write(frame.subarray(0, 3));
        setTimeout(() => {
          socket.write(frame.subarray(3, 9));
          socket.write(frame.subarray(9));
          socket.end();
        }, 25);
      });
    });
    await new Promise((resolve) => splitServer.listen(splitPath, resolve));
    try {
      const res = await callCompositor(splitPath, "health", {}, 5000);
      expect(res.ok).toBe(true);
      expect(res.data).toEqual({ hyprland: true });
    } finally {
      splitServer.close();
      rm(splitPath, { force: true });
    }
  });

  test("times out instead of hanging when the driver never answers", async () => {
    const silentPath = join(tmpdir(), `staka-compositor-silent-${process.pid}.sock`);
    const silentServer = createServer(() => {
      // Accept connections, never respond.
    });
    await new Promise((resolve) => silentServer.listen(silentPath, resolve));
    try {
      await expect(callCompositor(silentPath, "health", {}, 200)).rejects.toThrow("timed out");
    } finally {
      silentServer.close();
      rm(silentPath, { force: true });
    }
  });
});

describe("createCompositorTools", () => {
  const socketPath = join(tmpdir(), `staka-compositor-tools-${process.pid}.sock`);
  const requests: Request[] = [];
  let server: Server;

  beforeAll(async () => {
    server = await startMockDriver(socketPath, (req, res) => {
      requests.push(req);
      if (req.cmd === "screenshot") {
        res.json({ id: req.id, ok: true, data: { binary: true } });
        res.binary(PNG_BYTES);
        return;
      }
      if (req.cmd === "create_workspace") {
        res.json({
          id: req.id,
          ok: true,
          data: { output: "HEADLESS-2", workspace: "staka-agent-1" },
        });
        return;
      }
      if (req.cmd === "teardown") {
        res.json({ id: req.id, ok: true, data: { removed: ["HEADLESS-2"] } });
        return;
      }
      res.json({ id: req.id, ok: true });
    });
  });

  afterAll(() => {
    server.close();
    rm(socketPath, { force: true });
  });

  const screenshotDir = join(tmpdir(), `staka-compositor-shots-${process.pid}`);
  const tools = createCompositorTools({ socketPath, screenshotDir });

  test("exposes the compositor tool surface", () => {
    expect(tools.map((t) => t.name)).toEqual([
      "compositor_status",
      "compositor_start_app",
      "compositor_click",
      "compositor_type",
      "compositor_key",
      "compositor_screenshot",
      "compositor_teardown",
    ]);
  });

  test("compositor_status reports driver and Hyprland health", async () => {
    const result = await toolByName(tools, "compositor_status").execute("t1", {});
    expect(textOf(result)).toContain("running and Hyprland is reachable");
    expect(requests.at(-1)?.cmd).toBe("health");
  });

  test("compositor_start_app resolves the allowlist name to the driver command", async () => {
    const result = await toolByName(tools, "compositor_start_app").execute("t2", {
      app: "spreadsheet",
    });
    expect(textOf(result)).toContain("HEADLESS-2");
    expect(requests.at(-1)).toEqual({
      id: expect.any(Number),
      cmd: "create_workspace",
      args: { app: "libreoffice --calc" },
    });
  });

  test("compositor_click, compositor_type, and compositor_key send the right commands", async () => {
    await toolByName(tools, "compositor_click").execute("t3", { x: 320, y: 240 });
    expect(requests.at(-1)).toEqual({
      id: expect.any(Number),
      cmd: "click",
      args: { x: 320, y: 240 },
    });

    await toolByName(tools, "compositor_click").execute("t4", { x: 1, y: 2, button: "right" });
    expect(requests.at(-1)).toEqual({
      id: expect.any(Number),
      cmd: "click",
      args: { x: 1, y: 2, button: "right" },
    });

    await toolByName(tools, "compositor_type").execute("t5", { text: "hello" });
    expect(requests.at(-1)).toEqual({
      id: expect.any(Number),
      cmd: "type",
      args: { text: "hello" },
    });

    await toolByName(tools, "compositor_key").execute("t6", { keys: ["ctrl", "s"] });
    expect(requests.at(-1)).toEqual({
      id: expect.any(Number),
      cmd: "key",
      args: { keys: ["ctrl", "s"] },
    });
  });

  test("compositor_screenshot writes the captured PNG and reports the path", async () => {
    const result = await toolByName(tools, "compositor_screenshot").execute("t7", {});
    const text = textOf(result);
    expect(text).toContain("PNG");
    const match = text.match(/to (\S+\.png)/);
    expect(match).not.toBeNull();
    const written = await readFile(match![1]!);
    expect(written).toEqual(PNG_BYTES);
  });

  test("compositor_teardown reports what was removed", async () => {
    const result = await toolByName(tools, "compositor_teardown").execute("t8", {});
    expect(textOf(result)).toContain("HEADLESS-2");
  });
});

describe("compositor tools with no driver", () => {
  const missingPath = join(tmpdir(), `staka-compositor-absent-${process.pid}`, "compositor.sock");
  const tools = createCompositorTools({ socketPath: missingPath });

  test("compositor_status returns a not-available message instead of throwing", async () => {
    const result = await toolByName(tools, "compositor_status").execute("u1", {});
    expect(textOf(result)).toContain("compositor driver not available");
    expect(textOf(result)).toContain("staka-compositor");
  });

  test("every tool degrades to a not-available message", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["compositor_start_app", { app: "terminal" }],
      ["compositor_click", { x: 1, y: 2 }],
      ["compositor_type", { text: "hi" }],
      ["compositor_key", { keys: ["ctrl", "s"] }],
      ["compositor_screenshot", {}],
      ["compositor_teardown", {}],
    ];
    for (const [name, params] of cases) {
      const result = await toolByName(tools, name).execute("u2", params);
      expect(textOf(result)).toContain("compositor driver not available");
    }
  });

  test("callCompositor throws DriverUnavailableError when the socket is missing", async () => {
    await expect(callCompositor(missingPath, "health", {}, 1000)).rejects.toThrow(
      /compositor driver not available/,
    );
  });
});

describe("agent factory tool registration", () => {
  const env = {
    STAKA_STATE_DIR: join(tmpdir(), `staka-agent-state-${process.pid}`),
    STAKA_TOKEN_PATH: join(tmpdir(), `staka-token-${process.pid}`),
    STAKA_ORG_URL_PATH: join(tmpdir(), `staka-org-url-${process.pid}`),
    STAKA_AGENT_HOST: "127.0.0.1",
    STAKA_AGENT_PORT: 7920,
    STAKA_HEARTBEAT_INTERVAL_MS: 60_000,
    STAKA_CONFIG_REFRESH_MS: 300_000,
  } as Env;

  test("registers the compositor tools alongside the org tools", () => {
    const agent = createAgent({ env, orgUrl: "https://org.example", token: "t" });
    const names = agent.state.tools.map((t) => t.name);
    for (const expected of [
      "compositor_status",
      "compositor_start_app",
      "compositor_click",
      "compositor_type",
      "compositor_key",
      "compositor_screenshot",
      "compositor_teardown",
      "org_whoami",
    ]) {
      expect(names).toContain(expected);
    }
  });
});
