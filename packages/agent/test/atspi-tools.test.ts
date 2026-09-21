import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWalkerScript, createAtspiTools } from "../src/tools/atspi.ts";

function textOf(result: { content: Array<{ type: string; text?: string }> }) {
  return result.content[0].text ?? "";
}

function toolByName(tools: { name: string }[], name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`missing tool: ${name}`);
  return tool;
}

/// Stub "python" interpreters: shell scripts that answer like the real
/// AT-SPI walker for each scenario, so the tool is exercised end to end
/// without a GUI session.
const STUBS: Record<string, string> = {
  ok: `#!/bin/sh
echo '{"application":"org.gnome.Calculator","tree":{"name":"org.gnome.Calculator","role":"application","children":[{"name":"7","role":"push button"}]}}'
`,
  missing: `#!/bin/sh
echo '{"error":"app_not_found","applications":["org.gnome.Calculator","org.gnome.TextEditor"]}'
`,
  unavailable: `#!/bin/sh
echo '{"error":"atspi_unavailable","detail":"Typelib file for namespace Atspi not found"}'
`,
  garbage: `#!/bin/sh
echo 'not json at all'
`,
};

let stubDir: string;
const stubPaths: Record<string, string> = {};

beforeAll(async () => {
  stubDir = await mkdtemp(join(tmpdir(), "staka-atspi-"));
  for (const [name, script] of Object.entries(STUBS)) {
    const path = join(stubDir, `python-${name}`);
    await writeFile(path, script);
    await chmod(path, 0o755);
    stubPaths[name] = path;
  }
});

afterAll(async () => {
  if (stubDir) await rm(stubDir, { recursive: true, force: true });
});

describe("atspi_read tool", () => {
  test("returns the accessibility tree for a known app", async () => {
    const tools = createAtspiTools({ pythonBin: stubPaths.ok! });
    const result = await toolByName(tools, "atspi_read").execute("a1", {
      app_name: "org.gnome.Calculator",
    });
    const body = JSON.parse(textOf(result));
    expect(body.application).toBe("org.gnome.Calculator");
    expect(body.tree.role).toBe("application");
    expect(body.tree.children[0]!.name).toBe("7");
  });

  test("reports the running applications when the app is not found", async () => {
    const tools = createAtspiTools({ pythonBin: stubPaths.missing! });
    const result = await toolByName(tools, "atspi_read").execute("a2", {
      app_name: "org.missing.App",
    });
    expect(textOf(result)).toContain("app_not_found");
    expect(textOf(result)).toContain("org.gnome.TextEditor");
  });

  test("reports atspi_unavailable when the bindings are missing", async () => {
    const tools = createAtspiTools({ pythonBin: stubPaths.unavailable! });
    const result = await toolByName(tools, "atspi_read").execute("a3", {
      app_name: "org.gnome.Calculator",
    });
    expect(textOf(result)).toContain("atspi_unavailable");
    expect(textOf(result)).toContain("Typelib file");
  });

  test("reports honestly when the walker produces nothing parseable", async () => {
    const tools = createAtspiTools({ pythonBin: stubPaths.garbage! });
    const result = await toolByName(tools, "atspi_read").execute("a4", {
      app_name: "org.gnome.Calculator",
    });
    expect(textOf(result)).toContain("atspi_read failed");
  });

  test("the walker script passes the app name as data, not code", () => {
    const script = buildWalkerScript('weird"name', 12, 600);
    // The app name must not be interpolated into the script body; it only
    // travels through argv.
    expect(script).not.toContain('weird"name');
    expect(script).toContain("Atspi.get_desktop(0)");
    expect(script).toContain("MAX_DEPTH = 12");
  });
});
