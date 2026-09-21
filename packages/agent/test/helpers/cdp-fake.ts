import type { TargetInfo } from "../../src/cdp/targets.ts";

/**
 * Deterministic fake CDP target for tests: an HTTP server answering
 * /json/list and /json/version, plus a WebSocket endpoint speaking enough
 * of the DevTools protocol (Target.attachToTarget, Runtime.evaluate,
 * Page.navigate, Page.captureScreenshot, events) to exercise the client.
 *
 * Page behavior is driven by a small page model instead of a real engine:
 * the fake inspects evaluated expressions for the constructs our helpers
 * emit and answers with the model's values.
 */

export type FakePageModel = {
  title: string;
  url: string;
  text: string;
  selection: string;
  /// Elements by selector; click/type mutate entries here.
  elements: Map<
    string,
    { clicks: number; value?: string; missing?: boolean }
  >;
  screenshotPng?: Uint8Array;
};

export type FakeCdpServer = {
  port: number;
  targets: TargetInfo[];
  /// Commands the fake has received (method + params + sessionId).
  commands: Array<{ method: string; params: any; sessionId?: string }>;
  setModel(patch: Partial<FakePageModel>): void;
  /// Current page model (for assertions).
  getState(): FakePageModel;
  /// Broadcasts a CDP event to all connected sockets, optionally scoped to
  /// a session.
  emit(
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ): void;
  /// Closes all sockets and the server.
  close(): void;
};

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
]);

function extractSelector(expression: string): string | null {
  const match = expression.match(/document\.querySelector\((".*?")\)/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]!) as string;
  } catch {
    return null;
  }
}

function isSelectionProbe(expression: string): boolean {
  return expression.includes("getSelection");
}

function isTextProbe(expression: string): boolean {
  return expression.includes("document.body");
}

export function startFakeCdpServer(
  model: Partial<FakePageModel> = {},
): FakeCdpServer {
  const state: FakePageModel = {
    title: "Fake Dashboard",
    url: "https://dashboard.example/q3",
    text: "Q3 revenue: 4.82M KES\nGrowth: 12%",
    selection: "Q3 revenue: 4.82M KES",
    elements: new Map(),
    screenshotPng: PNG,
    ...model,
  };

  const commands: FakeCdpServer["commands"] = [];
  const sockets = new Set<any>();
  let nextSession = 0;
  const serverRef: { current: ReturnType<typeof Bun.serve> | null } = {
    current: null,
  };

  function evaluate(expression: string): unknown {
    if (isSelectionProbe(expression)) return state.selection;
    if (isTextProbe(expression)) return state.text;
    if (expression === "location.href") return state.url;
    if (expression === "document.title") return state.title;
    if (expression.includes(".click()")) {
      const selector = extractSelector(expression);
      const el = selector !== null ? state.elements.get(selector) : undefined;
      if (selector === null || !el || el.missing) {
        throw new Error("selector_not_found");
      }
      el.clicks += 1;
      state.elements.set(selector, el);
      return true;
    }
    if (expression.includes("dispatchEvent(new Event(\"input\"")) {
      const selector = extractSelector(expression);
      const valueEl = selector !== null ? state.elements.get(selector) : undefined;
      if (selector === null || !valueEl || valueEl.missing) {
        throw new Error("selector_not_found");
      }
      const valueMatch = expression.match(/setter\.call\(el, ("(?:[^"\\]|\\.)*")\)/);
      const value = valueMatch ? JSON.parse(valueMatch[1]!) as string : "";
      valueEl.value = value;
      state.elements.set(selector, valueEl);
      return true;
    }
    return null;
  }

  function handleMessage(ws: any, raw: string): void {
    let msg: { id?: number; method?: string; params?: any; sessionId?: string };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.id !== "number" || !msg.method) return;
    commands.push({
      method: msg.method,
      params: msg.params ?? {},
      sessionId: msg.sessionId,
    });

    const reply = (result: unknown) =>
      ws.send(JSON.stringify({ id: msg.id, result }));
    const fail = (message: string) =>
      ws.send(JSON.stringify({ id: msg.id, error: { message } }));

    switch (msg.method) {
      case "Target.attachToTarget": {
        const sessionId = `session-${++nextSession}`;
        reply({ sessionId });
        return;
      }
      case "Runtime.evaluate": {
        try {
          const value = evaluate(String(msg.params?.expression ?? ""));
          reply({ result: { value } });
        } catch (err) {
          reply({
            result: {},
            exceptionDetails: {
              exception: { value: String((err as Error).message) },
            },
          });
        }
        return;
      }
      case "Page.navigate": {
        state.url = String(msg.params?.url ?? state.url);
        reply({ frameId: "frame-1" });
        // Emulate the load event like a real browser would.
        ws.send(
          JSON.stringify({
            method: "Page.loadEventFired",
            sessionId: msg.sessionId,
            params: { timestamp: Date.now() / 1000 },
          }),
        );
        return;
      }
      case "Page.captureScreenshot": {
        reply({
          data: btoa(String.fromCharCode(...(state.screenshotPng ?? PNG))),
        });
        return;
      }
      case "Page.enable": {
        reply({});
        return;
      }
      case "Test.NoResponse": {
        // Deliberately unanswered, for client timeout tests.
        return;
      }
      default:
        fail(`unhandled method ${msg.method}`);
    }
  }

  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/json/list") {
        return Response.json(
          serverRef.current ? targetsFor(srv.port) : [],
        );
      }
      if (url.pathname === "/json/version") {
        return Response.json({ Browser: "staka-fake/1.0" });
      }
      if (url.pathname.startsWith("/devtools/")) {
        const upgraded = srv.upgrade(req, {
          data: { sessionId: null },
        });
        if (upgraded) return undefined;
        return new Response("upgrade failed", { status: 400 });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
      },
      message(ws, data) {
        handleMessage(ws, String(data));
      },
      close(ws) {
        sockets.delete(ws);
      },
    },
  });
  serverRef.current = server;

  function targetsFor(port: number): TargetInfo[] {
    return [
      {
        id: "page-1",
        type: "page",
        url: state.url,
        title: state.title,
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/1`,
      },
      {
        id: "page-2",
        type: "page",
        url: "about:blank",
        title: "Second tab",
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/2`,
      },
      {
        id: "worker-1",
        type: "service_worker",
        url: "service-worker.js",
        title: "",
        webSocketDebuggerUrl: null,
      },
    ];
  }

  const targets = targetsFor(server.port);

  return {
    port: server.port,
    targets,
    commands,
    setModel(patch) {
      Object.assign(state, patch);
    },
    getState() {
      return state;
    },
    emit(
      method: string,
      params: Record<string, unknown>,
      sessionId?: string,
    ) {
      for (const ws of sockets) {
        ws.send(
          JSON.stringify(
            sessionId ? { method, params, sessionId } : { method, params },
          ),
        );
      }
    },
    close() {
      for (const ws of sockets) ws.close();
      server.stop(true);
    },
  };
}
