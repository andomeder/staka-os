import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runWalkthrough,
  formatSteps,
  type WalkthroughStep,
} from "../src/demo/walkthrough.ts";
import { createBrowserTools } from "../src/tools/browser.ts";
import { createCompositorTools } from "../src/tools/compositor.ts";
import { createFsTools } from "../src/tools/fs.ts";
import { createDeliverTools } from "../src/tools/deliver.ts";
import { createOrgTools } from "../src/tools/org.ts";
import { createMemoryTool } from "../src/tools/memory.ts";
import { CdpConnection } from "../src/cdp/client.ts";
import type { BrowserHandle } from "../src/cdp/browser.ts";
import { startFakeCdpServer, type FakeCdpServer } from "./helpers/cdp-fake.ts";

const servers: FakeCdpServer[] = [];

// Memory writes live under $HOME/.staka/agent/memories; keep the walkthrough
// runs away from the real home (the health test counts real memory entries).
const origHome = process.env.HOME;
let testHome = "";

beforeAll(async () => {
  testHome = await mkdtemp(join(tmpdir(), "staka-walk-home-"));
  process.env.HOME = testHome;
});

afterAll(async () => {
  process.env.HOME = origHome;
  await rm(testHome, { recursive: true, force: true });
  for (const s of servers) s.close();
});

function statuses(steps: WalkthroughStep[]) {
  return Object.fromEntries(steps.map((s) => [s.name, s.status]));
}

async function makeOrgFixture() {
  const calls: Array<{ path: string; body: unknown }> = [];
  const orgUrl = "https://org.example";
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.pathname === "/v1/users/search") {
      const q = url.searchParams.get("q") ?? "";
      const matches = q.toLowerCase() === "ambiguous"
        ? [
            { id: "u1", employee_id: "EMP-1", display_name: "John Adamu", role: "staff", status: "active" },
            { id: "u2", employee_id: "EMP-2", display_name: "John Bikulu", role: "staff", status: "active" },
          ]
        : q.toLowerCase() === "nobody"
          ? []
          : [{ id: "u3", employee_id: "EMP-0042", display_name: "John Mwangi", role: "staff", status: "active" }];
      return new Response(JSON.stringify({ users: matches, count: matches.length }), {
        status: 200,
      });
    }
    if (url.pathname === "/v1/usage-logs") {
      return new Response(JSON.stringify({ id: 1, created_at: new Date().toISOString() }), {
        status: 201,
      });
    }
    if (url.pathname === "/v1/deliveries") {
      return new Response(
        JSON.stringify({
          id: "d-9",
          to_user: { employee_id: "EMP-0042", display_name: "John Mwangi" },
        }),
        { status: 201 },
      );
    }
    return new Response("{}", { status: 404 });
  };
  return { calls, orgUrl, fetchImpl };
}

describe("runWalkthrough (full happy path)", () => {
  test("captures selection, reads the report, resolves, delivers, remembers", async () => {
    const server = startFakeCdpServer();
    servers.push(server);
    const handle: BrowserHandle = {
      httpPort: server.port,
      targets: server.targets,
      launched: false,
    };
    const dir = await mkdtemp(join(tmpdir(), "staka-walk-"));
    const reportFile = join(dir, "q3-report.txt");
    await writeFile(reportFile, "Q3 revenue closed at 4.82M KES");

    const { orgUrl, fetchImpl } = await makeOrgFixture();
    const steps = await runWalkthrough({
      orgUrl,
      token: "tok",
      fetch: fetchImpl,
      reportDir: dir,
      reportFile,
      toolsets: {
        browser: createBrowserTools({
          ensure: async () => handle,
          connect: (wsUrl: string) => CdpConnection.connect(wsUrl),
        }),
        compositor: createCompositorTools({ socketPath: "/absent/compositor.sock" }),
        org: createOrgTools({ orgUrl, token: "tok", fetch: fetchImpl }),
        fs: createFsTools({
          allowlist: [dir],
          orgUrl,
          token: "tok",
          fetch: fetchImpl,
        }),
        deliver: createDeliverTools({ orgUrl, token: "tok", fetch: fetchImpl }),
        memory: [createMemoryTool()],
      },
    });

    const st = statuses(steps);
    expect(st["capture selection"]).toBe("ok");
    // No compositor driver: the demo degrades honestly and says so.
    expect(st["open headless spreadsheet"]).toBe("degraded");
    expect(steps.find((s) => s.name === "open headless spreadsheet")!.detail).toContain(
      "Falling back",
    );
    expect(st["read report file"]).toBe("ok");
    expect(st["resolve colleague"]).toBe("ok");
    expect(steps.find((s) => s.name === "resolve colleague")!.detail).toContain("EMP-0042");
    expect(st["deliver"]).toBe("ok");
    expect(st["remember"]).toBe("ok");

    const report = formatSteps(steps);
    expect(report).toContain("[ok]");
    expect(report).toContain("[degraded]");
    await rm(dir, { recursive: true, force: true });
  });
});

describe("runWalkthrough (degraded paths)", () => {
  test("browser unreachable: reports honestly and still completes the org chain", async () => {
    const dir = await mkdtemp(join(tmpdir(), "staka-walk-"));
    const { orgUrl, fetchImpl } = await makeOrgFixture();
    const steps = await runWalkthrough({
      orgUrl,
      token: "tok",
      fetch: fetchImpl,
      figure: "Q3 revenue: 4.82M KES (pasted)",
      toolsets: {
        browser: createBrowserTools({
          ensure: async () => {
            throw new Error("Chromium did not open a DevTools port in time");
          },
        }),
        compositor: createCompositorTools({ socketPath: "/absent/compositor.sock" }),
        org: createOrgTools({ orgUrl, token: "tok", fetch: fetchImpl }),
        fs: createFsTools({ allowlist: [dir], orgUrl, token: "tok", fetch: fetchImpl }),
        deliver: createDeliverTools({ orgUrl, token: "tok", fetch: fetchImpl }),
        memory: [createMemoryTool()],
      },
    });
    const st = statuses(steps);
    expect(st["capture selection"]).toBe("degraded");
    expect(steps.find((s) => s.name === "capture selection")!.detail).toContain(
      "browser_unreachable",
    );
    expect(st["open headless spreadsheet"]).toBe("degraded");
    expect(st["resolve colleague"]).toBe("ok");
    expect(st["deliver"]).toBe("ok");
    await rm(dir, { recursive: true, force: true });
  });

  test("ambiguous colleague: delivery is not attempted", async () => {
    const server = startFakeCdpServer();
    servers.push(server);
    const handle: BrowserHandle = {
      httpPort: server.port,
      targets: server.targets,
      launched: false,
    };
    const { orgUrl, fetchImpl } = await makeOrgFixture();
    const steps = await runWalkthrough({
      orgUrl,
      token: "tok",
      fetch: fetchImpl,
      colleagueQuery: "ambiguous",
      toolsets: {
        browser: createBrowserTools({
          ensure: async () => handle,
          connect: (wsUrl: string) => CdpConnection.connect(wsUrl),
        }),
        compositor: createCompositorTools({ socketPath: "/absent/compositor.sock" }),
        org: createOrgTools({ orgUrl, token: "tok", fetch: fetchImpl }),
        deliver: createDeliverTools({ orgUrl, token: "tok", fetch: fetchImpl }),
        memory: [createMemoryTool()],
      },
    });
    const st = statuses(steps);
    expect(st["resolve colleague"]).toBe("degraded");
    expect(steps.find((s) => s.name === "resolve colleague")!.detail).toContain(
      "Ask the user to pick",
    );
    expect(st["deliver"]).toBeUndefined();
    expect(st["remember"]).toBe("ok");
  });

  test("no such colleague: reported as failed, no delivery", async () => {
    const server = startFakeCdpServer();
    servers.push(server);
    const handle: BrowserHandle = {
      httpPort: server.port,
      targets: server.targets,
      launched: false,
    };
    const { orgUrl, fetchImpl } = await makeOrgFixture();
    const steps = await runWalkthrough({
      orgUrl,
      token: "tok",
      fetch: fetchImpl,
      colleagueQuery: "nobody",
      toolsets: {
        browser: createBrowserTools({
          ensure: async () => handle,
          connect: (wsUrl: string) => CdpConnection.connect(wsUrl),
        }),
        compositor: createCompositorTools({ socketPath: "/absent/compositor.sock" }),
        org: createOrgTools({ orgUrl, token: "tok", fetch: fetchImpl }),
        deliver: createDeliverTools({ orgUrl, token: "tok", fetch: fetchImpl }),
        memory: [createMemoryTool()],
      },
    });
    expect(statuses(steps)["resolve colleague"]).toBe("failed");
    expect(statuses(steps)["deliver"]).toBeUndefined();
  });

  test("disallowed report path: fs step fails honestly with path_denied", async () => {
    const server = startFakeCdpServer();
    servers.push(server);
    const handle: BrowserHandle = {
      httpPort: server.port,
      targets: server.targets,
      launched: false,
    };
    const allow = await mkdtemp(join(tmpdir(), "staka-walk-allow-"));
    const outside = await mkdtemp(join(tmpdir(), "staka-walk-out-"));
    await mkdir(join(outside, "x"), { recursive: true });
    const reportFile = join(outside, "secret.txt");
    await writeFile(reportFile, "nope");
    const { orgUrl, fetchImpl } = await makeOrgFixture();
    try {
      const steps = await runWalkthrough({
        orgUrl,
        token: "tok",
        fetch: fetchImpl,
        reportDir: allow,
        reportFile,
        toolsets: {
          browser: createBrowserTools({
            ensure: async () => handle,
            connect: (wsUrl: string) => CdpConnection.connect(wsUrl),
          }),
          compositor: createCompositorTools({ socketPath: "/absent/compositor.sock" }),
          org: createOrgTools({ orgUrl, token: "tok", fetch: fetchImpl }),
          fs: createFsTools({ allowlist: [allow], orgUrl, token: "tok", fetch: fetchImpl }),
          deliver: createDeliverTools({ orgUrl, token: "tok", fetch: fetchImpl }),
          memory: [createMemoryTool()],
        },
      });
      const fsStep = steps.find((s) => s.name === "read report file")!;
      expect(fsStep.status).toBe("failed");
      expect(fsStep.detail).toContain("path_denied");
    } finally {
      await rm(allow, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("demo fixtures", () => {
  test("the dashboard fixture and report file exist and mention the figure", async () => {
    const dashboard = join(import.meta.dir, "../../../test/demo/demo-dashboard.html");
    const report = join(import.meta.dir, "../../../test/demo/demo-report.txt");
    const html = await Bun.file(dashboard).text();
    const txt = await Bun.file(report).text();
    expect(html).toContain("4.82M KES");
    expect(html).toContain('id="amount"');
    expect(txt).toContain("4.82M KES");
    void copyFile;
  });
});
