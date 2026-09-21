/**
 * Page-level CDP helpers built on Target.attachToTarget sessions
 * (flatten: true). Everything here is structured access: evaluate JS in
 * the page, read its DOM and text selection, dispatch DOM-level clicks
 * and value changes. No screenshots for reading, no synthetic global
 * input - the user's seat is never touched.
 */

import type { CdpConnection } from "./client.ts";

export class SelectorNotFoundError extends Error {
  constructor(selector: string) {
    super(`selector not found: ${selector}`);
    this.name = "SelectorNotFoundError";
  }
}

export class PageEvaluationError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "PageEvaluationError";
  }
}

export type PageSession = {
  sessionId: string;
  evaluate: <T = unknown>(expression: string) => Promise<T>;
  navigate: (url: string) => Promise<{ url: string; title: string }>;
  getText: (maxChars: number) => Promise<string>;
  getSelection: () => Promise<string>;
  click: (selector: string) => Promise<void>;
  type: (selector: string, text: string) => Promise<void>;
  screenshotPng: () => Promise<Uint8Array>;
};

/// Attaches to a page target and returns a PageSession bound to it.
export async function attachToPage(
  conn: CdpConnection,
  targetId: string,
): Promise<PageSession> {
  const res = await conn.send<{ sessionId: string }>("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  const sessionId = res.sessionId;
  if (!sessionId) throw new Error("attachToTarget returned no sessionId");
  return makePageSession(conn, sessionId);
}

const evalTimeoutMs = 10_000;

export function makePageSession(
  conn: CdpConnection,
  sessionId: string,
): PageSession {
  async function evaluate<T>(expression: string): Promise<T> {
    const res = await conn.send<{
      result?: { value?: unknown };
      exceptionDetails?: { exception?: { description?: string; value?: unknown } };
    }>(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
      },
      sessionId,
      evalTimeoutMs,
    );
    if (res.exceptionDetails) {
      const ex = res.exceptionDetails.exception ?? {};
      const detail =
        typeof ex.value === "string"
          ? ex.value
          : (ex.description ?? "page evaluation failed");
      throw new PageEvaluationError(detail);
    }
    return res.result?.value as T;
  }

  async function navigate(url: string): Promise<{ url: string; title: string }> {
    await conn.send("Page.enable", {}, sessionId, 5_000).catch(() => {
      // Page.enable failing should not block navigation on older targets.
    });
    await conn.send("Page.navigate", { url }, sessionId, evalTimeoutMs);
    // Wait for the load event, but do not hang forever on pages that
    // never settle; the title read below is the real success check.
    await conn
      .waitEvent("Page.loadEventFired", sessionId, 8_000)
      .catch(() => undefined);
    const actualUrl = await evaluate<string>("location.href");
    const title = await evaluate<string>("document.title");
    return { url: actualUrl ?? url, title: title ?? "" };
  }

  return {
    sessionId,
    evaluate,
    navigate,
    getText: (maxChars: number) =>
      evaluate<string>(
        `(document.body?.innerText ?? "").slice(0, ${Math.max(1, Math.floor(maxChars))})`,
      ),
    getSelection: () =>
      evaluate<string>("window.getSelection() ? window.getSelection().toString() : \"\""),
    click: async (selector: string) => {
      const ok = await evaluate<boolean>(
        `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) { throw new Error("selector_not_found"); }
  el.click();
  return true;
})()`,
      );
      if (!ok) throw new PageEvaluationError("click did not report success");
    },
    type: async (selector: string, text: string) => {
      const ok = await evaluate<boolean>(
        `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) { throw new Error("selector_not_found"); }
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (!setter) { throw new Error("element_has_no_value_setter"); }
  setter.call(el, ${JSON.stringify(text)});
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
})()`,
      );
      if (!ok) throw new PageEvaluationError("type did not report success");
    },
    screenshotPng: async () => {
      const res = await conn.send<{ data: string }>(
        "Page.captureScreenshot",
        { format: "png" },
        sessionId,
        evalTimeoutMs,
      );
      return Uint8Array.from(atob(res.data), (c) => c.charCodeAt(0));
    },
  };
}
