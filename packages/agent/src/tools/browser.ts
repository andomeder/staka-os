import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CdpConnection, CdpDisconnectedError, CdpError } from "../cdp/client.ts";
import {
  attachToPage,
  PageEvaluationError,
  SelectorNotFoundError,
  type PageSession,
} from "../cdp/page.ts";
import {
  defaultProfileDir,
  ensureBrowser,
  type BrowserHandle,
  type EnsureBrowserOptions,
} from "../cdp/browser.ts";
import { pageTargets, type TargetInfo } from "../cdp/targets.ts";

/**
 * browser_* tools: structured access to the Staka-managed Chromium over the
 * Chrome DevTools Protocol. The browser is launched by Staka with a
 * dedicated profile dir and an ephemeral loopback debugging port; personal
 * browser profiles are never touched.
 *
 * Failure policy (no silent degradation): every access failure returns a
 * plain-text explanation naming the failure (browser unreachable, no
 * selection, selector not found) so the agent can relay it honestly.
 */

export const DEFAULT_SCREENSHOT_DIR = join(tmpdir(), "staka-browser");

export type BrowserToolsDeps = {
  profileDir?: string;
  chromiumBin?: string;
  headless?: boolean;
  /// Browser endpoint resolver; overridable in tests to point at a fake
  /// CDP target instead of spawning Chromium.
  ensure?: (opts: EnsureBrowserOptions) => Promise<BrowserHandle>;
  /// Connection factory; overridable in tests.
  connect?: (wsUrl: string) => Promise<CdpConnection>;
  screenshotDir?: string;
};

function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: {},
  };
}

const UNREACHABLE_HINT =
  "The Staka-managed browser is not reachable. Use browser_open to start it, then retry.";

class BrowserSession {
  private conn: CdpConnection | null = null;
  private activeTargetId: string | null = null;

  constructor(private deps: BrowserToolsDeps & { profileDir: string }) {}

  private options(): EnsureBrowserOptions {
    return {
      profileDir: this.deps.profileDir,
      chromiumBin: this.deps.chromiumBin,
      headless: this.deps.headless,
    };
  }

  /// Resolves a live browser handle (reusing the running instance when its
  /// DevToolsActivePort is still valid) and a connected CDP connection.
  private async acquire(): Promise<{ handle: BrowserHandle; conn: CdpConnection }> {
    const handle = await this.ensure();
    if (!this.conn || !this.conn.isOpen) {
      const wsUrl = handle.targets.find((t) => t.webSocketDebuggerUrl)
        ?.webSocketDebuggerUrl;
      if (!wsUrl) throw new Error("browser has no connectable target");
      this.conn = this.deps.connect
        ? await this.deps.connect(wsUrl)
        : await CdpConnection.connect(wsUrl);
    }
    return { handle, conn: this.conn };
  }

  private ensure(): Promise<BrowserHandle> {
    const fn = this.deps.ensure ?? ensureBrowser;
    return fn(this.options());
  }

  /// Attaches to the active page target (or the first page). Every call
  /// re-acquires the handle, so the target list is never stale.
  private async page(): Promise<PageSession> {
    const { handle, conn } = await this.acquire();
    const pages = pageTargets(handle.targets);
    const active =
      pages.find((t) => t.id === this.activeTargetId) ?? pages[0] ?? null;
    if (!active) throw new Error("browser has no open page");
    this.activeTargetId = active.id;
    return attachToPage(conn, active.id);
  }

  private async tabs(): Promise<TargetInfo[]> {
    const { handle } = await this.acquire();
    return pageTargets(handle.targets);
  }

  setActiveTab(targetId: string): void {
    this.activeTargetId = targetId;
  }

  async open(url?: string): Promise<{
    target_id: string;
    url: string;
    title: string;
    reused: boolean;
  }> {
    const handle = await (this.deps.ensure ?? ensureBrowser)({
      ...this.options(),
      url,
    });
    if (!this.conn || !this.conn.isOpen) {
      const wsUrl = handle.targets.find((t) => t.webSocketDebuggerUrl)
        ?.webSocketDebuggerUrl;
      if (!wsUrl) throw new Error("browser has no connectable target");
      this.conn = this.deps.connect
        ? await this.deps.connect(wsUrl)
        : await CdpConnection.connect(wsUrl);
    }
    const conn = this.conn!;
    const pages = pageTargets(handle.targets);
    const page = pages[0];
    if (!page) throw new Error("browser has no open page");
    this.activeTargetId = page.id;
    const ps = await attachToPage(conn, page.id);
    let finalUrl = page.url;
    let title = page.title;
    if (url) {
      const nav = await ps.navigate(url);
      finalUrl = nav.url;
      title = nav.title;
    }
    return {
      target_id: page.id,
      url: finalUrl,
      title,
      reused: !handle.launched,
    };
  }
}

export function createBrowserTools(deps: BrowserToolsDeps = {}): AgentTool[] {
  const session = new BrowserSession({
    ...deps,
    profileDir: deps.profileDir ?? defaultProfileDir(),
  });

  function unreachable(err: unknown): string | null {
    if (err instanceof CdpDisconnectedError || err instanceof CdpError) {
      return `${err.message}. ${UNREACHABLE_HINT}`;
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (
      /not reachable|ECONNREFUSED|failed to connect|timed out|no connectable target|DevTools port/.test(
        msg,
      )
    ) {
      return `${msg}. ${UNREACHABLE_HINT}`;
    }
    return null;
  }

  function fail(tool: string, err: unknown) {
    const un = unreachable(err);
    if (un) return textResult(`browser_unreachable: ${un}`);
    return textResult(
      `${tool} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const open: AgentTool = {
    name: "browser_open",
    label: "Browser open",
    description:
      "Open (or reuse) the Staka-managed Chromium and optionally navigate it to a URL. " +
      "Returns the active tab's target id, URL and title. Uses a dedicated Staka profile, never the user's personal browser.",
    parameters: Type.Object({
      url: Type.Optional(
        Type.String({ description: "URL to open in app mode." }),
      ),
    }),
    execute: async (_toolCallId, params: { url?: string }) => {
      try {
        return textResult(JSON.stringify(await session.open(params.url)));
      } catch (err) {
        return fail("browser_open", err);
      }
    },
  };

  const listTabs: AgentTool = {
    name: "browser_list_tabs",
    label: "Browser list tabs",
    description: "List open pages (tabs) in the Staka-managed Chromium.",
    parameters: Type.Object({}),
    execute: async () => {
      try {
        const tabs = await session.tabs();
        return textResult(
          JSON.stringify(
            tabs.map((t) => ({
              target_id: t.id,
              url: t.url,
              title: t.title,
            })),
          ),
        );
      } catch (err) {
        return fail("browser_list_tabs", err);
      }
    },
  };

  const switchTab: AgentTool = {
    name: "browser_switch_tab",
    label: "Browser switch tab",
    description:
      "Make a listed tab the active target for browser_* operations. Pass the target_id from browser_list_tabs.",
    parameters: Type.Object({
      target_id: Type.String({
        description: "Target id from browser_list_tabs.",
      }),
    }),
    execute: async (_toolCallId, params: { target_id: string }) => {
      try {
        const tabs = await session.tabs();
        if (!tabs.some((t) => t.id === params.target_id)) {
          return textResult(
            `selector_not_found: no tab with target_id ${params.target_id}. Call browser_list_tabs first.`,
          );
        }
        session.setActiveTab(params.target_id);
        return textResult(`Active tab is now ${params.target_id}.`);
      } catch (err) {
        return fail("browser_switch_tab", err);
      }
    },
  };

  const navigate: AgentTool = {
    name: "browser_navigate",
    label: "Browser navigate",
    description:
      "Navigate the active tab of the Staka-managed Chromium to a URL.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to load." }),
    }),
    execute: async (_toolCallId, params: { url: string }) => {
      try {
        const ps = await session.page();
        return textResult(JSON.stringify(await ps.navigate(params.url)));
      } catch (err) {
        return fail("browser_navigate", err);
      }
    },
  };

  const getDom: AgentTool = {
    name: "browser_get_dom",
    label: "Browser get DOM",
    description:
      "Read the active tab's visible text (trimmed). Structured DOM access over CDP; no screenshots.",
    parameters: Type.Object({
      max_chars: Type.Optional(
        Type.Number({
          description: "Maximum characters of text to return (default 4000).",
        }),
      ),
    }),
    execute: async (_toolCallId, params: { max_chars?: number }) => {
      try {
        const ps = await session.page();
        return textResult(
          JSON.stringify({ text: await ps.getText(params.max_chars ?? 4000) }),
        );
      } catch (err) {
        return fail("browser_get_dom", err);
      }
    },
  };

  const getSelection: AgentTool = {
    name: "browser_get_selection",
    label: "Browser get selection",
    description:
      "Read the text the user has selected in the active tab of the Staka-managed Chromium.",
    parameters: Type.Object({}),
    execute: async () => {
      try {
        const ps = await session.page();
        const selection = await ps.getSelection();
        if (!selection) {
          return textResult(
            "empty_selection: nothing is selected in the active tab. Ask the user to select the text, then retry.",
          );
        }
        return textResult(JSON.stringify({ text: selection }));
      } catch (err) {
        return fail("browser_get_selection", err);
      }
    },
  };

  const click: AgentTool = {
    name: "browser_click",
    label: "Browser click",
    description:
      "Click an element in the active tab by CSS selector (DOM click; the user's cursor never moves).",
    parameters: Type.Object({
      selector: Type.String({
        description: "CSS selector of the element to click.",
      }),
    }),
    execute: async (_toolCallId, params: { selector: string }) => {
      try {
        const ps = await session.page();
        await ps.click(params.selector);
        return textResult(`Clicked ${params.selector}.`);
      } catch (err) {
        if (selectorMissing(err)) {
          return textResult(`selector_not_found: ${selectorMessage(err)}`);
        }
        return fail("browser_click", err);
      }
    },
  };

  const type: AgentTool = {
    name: "browser_type",
    label: "Browser type",
    description:
      "Set the value of an input or textarea in the active tab by CSS selector and dispatch input/change events.",
    parameters: Type.Object({
      selector: Type.String({
        description: "CSS selector of the input element.",
      }),
      text: Type.String({ description: "Text to set." }),
    }),
    execute: async (
      _toolCallId,
      params: { selector: string; text: string },
    ) => {
      try {
        const ps = await session.page();
        await ps.type(params.selector, params.text);
        return textResult(
          `Set ${params.selector} to ${params.text.length} characters.`,
        );
      } catch (err) {
        if (selectorMissing(err)) {
          return textResult(`selector_not_found: ${selectorMessage(err)}`);
        }
        return fail("browser_type", err);
      }
    },
  };

  const screenshot: AgentTool = {
    name: "browser_screenshot",
    label: "Browser screenshot",
    description:
      "Capture a PNG of the active tab (page content only) and save it to a local file. Returns the file path.",
    parameters: Type.Object({}),
    execute: async () => {
      try {
        const ps = await session.page();
        const png = await ps.screenshotPng();
        const dir = deps.screenshotDir ?? DEFAULT_SCREENSHOT_DIR;
        await mkdir(dir, { recursive: true });
        const path = join(dir, `staka-browser-${Date.now()}.png`);
        await writeFile(path, png);
        return textResult(
          `Captured a ${png.length}-byte PNG of the active tab to ${path}.`,
        );
      } catch (err) {
        return fail("browser_screenshot", err);
      }
    },
  };

  return [
    open,
    listTabs,
    switchTab,
    navigate,
    getDom,
    getSelection,
    click,
    type,
    screenshot,
  ];
}

function selectorMissing(err: unknown): boolean {
  return (
    err instanceof SelectorNotFoundError ||
    (err instanceof PageEvaluationError && err.message.includes("selector_not_found"))
  );
}

function selectorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
