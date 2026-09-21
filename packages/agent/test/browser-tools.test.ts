import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserTools } from "../src/tools/browser.ts";
import { CdpConnection } from "../src/cdp/client.ts";
import type { BrowserHandle } from "../src/cdp/browser.ts";
import { startFakeCdpServer, type FakeCdpServer } from "./helpers/cdp-fake.ts";

const servers: FakeCdpServer[] = [];

afterAll(() => {
  for (const s of servers) s.close();
});

async function makeDeps(model: Parameters<typeof startFakeCdpServer>[0] = {}) {
  const server = startFakeCdpServer(model);
  servers.push(server);
  const handle: BrowserHandle = {
    httpPort: server.port,
    targets: server.targets,
    launched: false,
  };
  return {
    server,
    deps: {
      ensure: async () => handle,
      connect: (wsUrl: string) => CdpConnection.connect(wsUrl),
    },
  };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }) {
  return result.content[0].text ?? "";
}

function toolByName(tools: { name: string }[], name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`missing tool: ${name}`);
  return tool;
}

describe("createBrowserTools", () => {
  test("exposes the browser tool surface", async () => {
    const { deps } = await makeDeps();
    const tools = createBrowserTools(deps);
    expect(tools.map((t) => t.name)).toEqual([
      "browser_open",
      "browser_list_tabs",
      "browser_switch_tab",
      "browser_navigate",
      "browser_get_dom",
      "browser_get_selection",
      "browser_click",
      "browser_type",
      "browser_screenshot",
    ]);
  });

  test("browser_open returns the active tab and reuses the browser", async () => {
    const { deps } = await makeDeps();
    const tools = createBrowserTools(deps);
    const result = await toolByName(tools, "browser_open").execute("t1", {
      url: "https://dashboard.example/q3",
    });
    const body = JSON.parse(textOf(result));
    expect(body.target_id).toBe("page-1");
    expect(body.url).toBe("https://dashboard.example/q3");
    expect(body.title).toBe("Fake Dashboard");
    expect(body.reused).toBe(true);
  });

  test("browser_get_selection captures the user's selected text", async () => {
    const { deps } = await makeDeps();
    const tools = createBrowserTools(deps);
    const result = await toolByName(tools, "browser_get_selection").execute(
      "t2",
      {},
    );
    const body = JSON.parse(textOf(result));
    expect(body.text).toBe("Q3 revenue: 4.82M KES");
  });

  test("browser_get_selection reports an empty selection honestly", async () => {
    const { deps } = await makeDeps({ selection: "" });
    const tools = createBrowserTools(deps);
    const result = await toolByName(tools, "browser_get_selection").execute(
      "t3",
      {},
    );
    expect(textOf(result)).toContain("empty_selection");
  });

  test("browser_get_dom returns trimmed page text", async () => {
    const { deps } = await makeDeps();
    const tools = createBrowserTools(deps);
    const result = await toolByName(tools, "browser_get_dom").execute("t4", {});
    const body = JSON.parse(textOf(result));
    expect(body.text).toContain("Q3 revenue");
  });

  test("browser_click and browser_type round-trip against the page model", async () => {
    const { deps, server } = await makeDeps();
    const tools = createBrowserTools(deps);
    server.setModel({
      elements: new Map([
        ["#submit", { clicks: 0 }],
        ["#amount", { clicks: 0 }],
      ]),
    });

    const click = await toolByName(tools, "browser_click").execute("t5", {
      selector: "#submit",
    });
    expect(textOf(click)).toContain("Clicked #submit");

    const type = await toolByName(tools, "browser_type").execute("t6", {
      selector: "#amount",
      text: "4.82M",
    });
    expect(textOf(type)).toContain("Set #amount");

    expect(server.commands.map((c) => c.method)).toContain("Runtime.evaluate");
    expect(server.getState().elements.get("#submit")?.clicks).toBe(1);
    expect(server.getState().elements.get("#amount")?.value).toBe("4.82M");
  });

  test("browser_click reports selector_not_found for a missing element", async () => {
    const { deps } = await makeDeps();
    const tools = createBrowserTools(deps);
    const result = await toolByName(tools, "browser_click").execute("t7", {
      selector: "#does-not-exist",
    });
    expect(textOf(result)).toContain("selector_not_found");
  });

  test("browser_screenshot writes a PNG file", async () => {
    const { deps } = await makeDeps();
    const dir = await mkdtemp(join(tmpdir(), "staka-browser-test-"));
    const tools = createBrowserTools({ ...deps, screenshotDir: dir });
    const result = await toolByName(tools, "browser_screenshot").execute(
      "t8",
      {},
    );
    expect(textOf(result)).toMatch(/Captured a \d+-byte PNG/);
    const files = await readdir(dir);
    expect(files.length).toBe(1);
    await rm(dir, { recursive: true, force: true });
  });

  test("browser_list_tabs enumerates page targets only", async () => {
    const { deps } = await makeDeps();
    const tools = createBrowserTools(deps);
    const result = await toolByName(tools, "browser_list_tabs").execute(
      "t9",
      {},
    );
    const tabs = JSON.parse(textOf(result));
    expect(tabs).toHaveLength(2);
    expect(tabs.map((t: { target_id: string }) => t.target_id)).toEqual([
      "page-1",
      "page-2",
    ]);
  });

  test("browser_switch_tab rejects an unknown target id", async () => {
    const { deps } = await makeDeps();
    const tools = createBrowserTools(deps);
    const result = await toolByName(tools, "browser_switch_tab").execute(
      "t10",
      { target_id: "nope" },
    );
    expect(textOf(result)).toContain("selector_not_found");
  });

  test("every tool reports browser_unreachable when the browser is gone", async () => {
    const deps = {
      ensure: async () => {
        throw new Error("Chromium did not open a DevTools port in time");
      },
    };
    const tools = createBrowserTools(deps);
    const cases: Array<[string, Record<string, unknown>]> = [
      ["browser_open", {}],
      ["browser_list_tabs", {}],
      ["browser_navigate", { url: "https://x.example" }],
      ["browser_get_dom", {}],
      ["browser_get_selection", {}],
      ["browser_click", { selector: "#a" }],
      ["browser_type", { selector: "#a", text: "x" }],
      ["browser_screenshot", {}],
    ];
    for (const [name, params] of cases) {
      const result = await toolByName(tools, name).execute("u1", params);
      expect(textOf(result)).toContain("browser_unreachable");
      expect(textOf(result)).toContain("browser_open");
    }
  });
});
