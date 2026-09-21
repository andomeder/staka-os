/**
 * Thin Chrome DevTools Protocol client over a WebSocket.
 *
 * The protocol is JSON-RPC over a single WebSocket connection: requests
 * carry an incrementing `id`, responses echo it, and events arrive with a
 * `method` (and, with `flatten: true` sessions, a `sessionId`). This client
 * keeps the surface small: correlated `send`, event subscription, and
 * nothing else. No puppeteer - the lifecycle stays ours.
 */

export class CdpError extends Error {
  readonly code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.name = "CdpError";
    if (code !== undefined) this.code = code;
  }
}

export class CdpDisconnectedError extends Error {
  constructor(detail?: string) {
    super(`CDP connection closed${detail ? `: ${detail}` : ""}`);
    this.name = "CdpDisconnectedError";
  }
}

export type CdpEvent = {
  method: string;
  sessionId?: string;
  params: Record<string, unknown>;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type CdpConnectOptions = {
  /// Per-command timeout. The default covers page loads on a slow machine.
  timeoutMs?: number;
  /// WebSocket constructor override (tests inject an in-process pair).
  WebSocket?: typeof WebSocket;
};

const DEFAULT_TIMEOUT_MS = 10_000;

export class CdpConnection {
  private readonly ws: WebSocket;
  private readonly pending = new Map<number, Pending>();
  private readonly handlers = new Map<string, Set<(ev: CdpEvent) => void>>();
  private nextId = 1;
  private timeoutMs: number;
  private closed = false;

  private constructor(ws: WebSocket, timeoutMs: number) {
    this.ws = ws;
    this.timeoutMs = timeoutMs;
    ws.addEventListener("message", (ev) => this.onMessage(String(ev.data)));
    ws.addEventListener("close", () => this.onClose());
    ws.addEventListener("error", () => this.onClose());
  }

  static async connect(
    wsUrl: string,
    opts: CdpConnectOptions = {},
  ): Promise<CdpConnection> {
    const WS = opts.WebSocket ?? WebSocket;
    const ws = new WS(wsUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out connecting to ${wsUrl}`)),
        opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      ws.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      ws.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error(`failed to connect to ${wsUrl}`));
        },
        { once: true },
      );
    });
    return new CdpConnection(ws, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  /// Sends one command and resolves with its `result`. Protocol errors
  /// (an `error` object in the response) reject with CdpError.
  send<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeoutMs?: number,
  ): Promise<T> {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new CdpDisconnectedError());
    }
    const id = this.nextId++;
    const limit = timeoutMs ?? this.timeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`${method} timed out after ${limit}ms`));
      }, limit);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  /// Subscribes to events by method name. Returns an unsubscribe function.
  on(method: string, handler: (ev: CdpEvent) => void): () => void {
    let set = this.handlers.get(method);
    if (!set) {
      set = new Set();
      this.handlers.set(method, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }

  /// Resolves with the next event matching method (and sessionId when given).
  waitEvent(
    method: string,
    sessionId?: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<CdpEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new CdpError(`timed out waiting for ${method} event`));
      }, timeoutMs);
      const off = this.on(method, (ev) => {
        if (sessionId !== undefined && ev.sessionId !== sessionId) return;
        clearTimeout(timer);
        off();
        resolve(ev);
      });
    });
  }

  /// Whether the underlying WebSocket is still open.
  get isOpen(): boolean {
    return !this.closed && this.ws.readyState === WebSocket.OPEN;
  }

  close(): void {
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      // already closed
    }
    this.onClose();
  }

  private onMessage(text: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
        const err = msg.error as { message?: string; code?: number };
        entry.reject(new CdpError(err.message ?? "CDP error", err.code));
      } else {
        entry.resolve(msg.result ?? {});
      }
      return;
    }
    if (typeof msg.method === "string") {
      const ev: CdpEvent = {
        method: msg.method,
        params: (msg.params as Record<string, unknown>) ?? {},
      };
      if (typeof msg.sessionId === "string") ev.sessionId = msg.sessionId;
      const set = this.handlers.get(msg.method);
      if (set) for (const h of set) h(ev);
    }
  }

  private onClose(): void {
    this.closed = true;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new CdpDisconnectedError());
    }
    this.pending.clear();
  }
}
