import { afterAll, describe, expect, test } from "bun:test";
import {
  CdpConnection,
  CdpDisconnectedError,
  CdpError,
} from "../src/cdp/client.ts";
import { startFakeCdpServer } from "./helpers/cdp-fake.ts";

const servers: ReturnType<typeof startFakeCdpServer>[] = [];

function makeServer() {
  const server = startFakeCdpServer();
  servers.push(server);
  return server;
}

afterAll(() => {
  for (const s of servers) s.close();
});

function wsUrl(server: ReturnType<typeof startFakeCdpServer>): string {
  return server.targets[0]!.webSocketDebuggerUrl!;
}

describe("CdpConnection", () => {
  test("connects over a WebSocket to the target endpoint", async () => {
    const server = makeServer();
    const conn = await CdpConnection.connect(wsUrl(server));
    expect(conn.isOpen).toBe(true);
    conn.close();
    expect(conn.isOpen).toBe(false);
  });

  test("correlates responses with requests by id", async () => {
    const server = makeServer();
    const conn = await CdpConnection.connect(wsUrl(server));
    const [a, b] = await Promise.all([
      conn.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: "page-1",
        flatten: true,
      }),
      conn.send("Page.enable"),
    ]);
    expect(a.sessionId).toBe("session-1");
    expect(server.commands.map((c) => c.method)).toEqual([
      "Target.attachToTarget",
      "Page.enable",
    ]);
    conn.close();
  });

  test("rejects with CdpError when the target answers with an error", async () => {
    const server = makeServer();
    const conn = await CdpConnection.connect(wsUrl(server));
    await expect(
      conn.send("Not.ARealDomain"),
    ).rejects.toThrow(/unhandled method/);
    await expect(
      conn.send("Not.ARealDomain"),
    ).rejects.toBeInstanceOf(CdpError);
    conn.close();
  });

  test("routes events to subscribers with their sessionId", async () => {
    const server = makeServer();
    const conn = await CdpConnection.connect(wsUrl(server));
    const seen: Array<{ method: string; sessionId?: string }> = [];
    const off = conn.on("Page.loadEventFired", (ev) =>
      seen.push({ method: ev.method, sessionId: ev.sessionId }),
    );
    server.emit("Page.loadEventFired", { timestamp: 1 });
    server.emit("Page.screencastFrame", {});
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual([{ method: "Page.loadEventFired", sessionId: undefined }]);
    off();
    server.emit("Page.loadEventFired", { timestamp: 2 });
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toHaveLength(1);
    conn.close();
  });

  test("waitEvent resolves only for a matching sessionId", async () => {
    const server = makeServer();
    const conn = await CdpConnection.connect(wsUrl(server));
    const { sessionId } = await conn.send<{ sessionId: string }>(
      "Target.attachToTarget",
      { targetId: "page-1", flatten: true },
    );

    const matched = conn.waitEvent("Page.loadEventFired", sessionId, 2_000);
    server.emit("Page.loadEventFired", {}, "someone-elses-session");
    server.emit("Page.loadEventFired", {});
    server.emit("Page.loadEventFired", { timestamp: 1 }, sessionId);
    const ev = await matched;
    expect(ev.method).toBe("Page.loadEventFired");

    const never = conn.waitEvent("Page.loadEventFired", sessionId, 100);
    await expect(never).rejects.toThrow(/timed out/);
    conn.close();
  });

  test("times out a command that never gets a response", async () => {
    const server = makeServer();
    const conn = await CdpConnection.connect(wsUrl(server));
    await expect(
      conn.send("Test.NoResponse", undefined, undefined, 100),
    ).rejects.toThrow(/timed out/);
    conn.close();
  });

  test("rejects pending commands when the connection drops", async () => {
    const server = makeServer();
    const conn = await CdpConnection.connect(wsUrl(server));
    const pending = conn.send("Page.enable").catch((e) => e);
    server.close();
    await new Promise((r) => setTimeout(r, 20));
    const err = await pending;
    expect(err).toBeInstanceOf(CdpDisconnectedError);
  });
});
