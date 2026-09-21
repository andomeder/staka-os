import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

/**
 * Experimental AT-SPI2 access: read a native GTK/Qt application's
 * accessibility tree over the D-Bus AT-SPI registry, via a one-shot Python
 * (pygobject Atspi) walker. This is a layer-2 breadth probe - evidence that
 * the same structured-access approach used for Chromium (CDP) extends to
 * native apps - not a production access layer. It never synthesizes input.
 *
 * The walker is capped (depth and node count) so a huge tree cannot stall
 * the agent. When the AT-SPI stack is absent (no pygobject, no accessibility
 * bus) the tool says so instead of falling back to anything else.
 */

export type AtspiNode = {
  name: string;
  role: string;
  text?: string;
  children?: AtspiNode[];
};

export type AtspiToolsDeps = {
  /// Python interpreter with pygobject's Atspi bindings.
  pythonBin?: string;
  timeoutMs?: number;
  maxDepth?: number;
  maxNodes?: number;
};

function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: {},
  };
}

export function buildWalkerScript(appName: string, maxDepth: number, maxNodes: number): string {
  // One-shot walker: find the application by name under the desktop node,
  // emit a capped JSON tree. Kept literal (no shell interpolation).
  return `
import json, sys
try:
    import gi
    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi
except Exception as exc:
    print(json.dumps({"error": "atspi_unavailable", "detail": str(exc)}))
    sys.exit(0)

MAX_DEPTH = ${maxDepth}
MAX_NODES = ${maxNodes}
count = 0

def walk(node, depth):
    global count
    if node is None or depth > MAX_DEPTH or count >= MAX_NODES:
        return None
    count += 1
    try:
        name = node.get_name() or ""
        role = Atspi.Role.get_name(node.get_role())
        text = None
        if role in ("text", "document text", "document web", "entry", "paragraph"):
            try:
                text = (node.get_text(0, 400) or "").strip() or None
            except Exception:
                pass
        out = {"name": name, "role": role}
        if text:
            out["text"] = text
        n = node.get_child_count()
        kids = []
        for i in range(min(n, 64)):
            child = walk(node.get_child_at_index(i), depth + 1)
            if child:
                kids.append(child)
            if count >= MAX_NODES:
                break
        if kids:
            out["children"] = kids
        return out
    except Exception:
        return None

app_name = json.loads(sys.argv[1]) if len(sys.argv) > 1 else ""
desktop = Atspi.get_desktop(0)
matched = None
for i in range(desktop.get_child_count()):
    app = desktop.get_child_at_index(i)
    if app and (app.get_name() or "") == app_name:
        matched = app
        break
if matched is None:
    known = [desktop.get_child_at_index(i).get_name() for i in range(desktop.get_child_count())]
    print(json.dumps({"error": "app_not_found", "applications": known}))
else:
    tree = walk(matched, 0)
    print(json.dumps({"application": app_name, "tree": tree}))
`;
}

export function createAtspiTools(deps: AtspiToolsDeps = {}): AgentTool[] {
  const pythonBin = deps.pythonBin ?? process.env.STAKA_ATSPI_PYTHON ?? "python3";
  const timeoutMs = deps.timeoutMs ?? 8_000;
  const maxDepth = deps.maxDepth ?? 12;
  const maxNodes = deps.maxNodes ?? 600;

  const read: AgentTool = {
    name: "atspi_read",
    label: "AT-SPI read (experimental)",
    description:
      "EXPERIMENTAL: read a native (GTK/Qt) application's accessibility tree by exact application name over AT-SPI. " +
      "Structured access for apps outside Chromium. Fails honestly when the AT-SPI stack or the app is unavailable; never falls back to screenshots.",
    parameters: Type.Object({
      app_name: Type.String({
        description: "Exact AT-SPI application name (e.g. \"org.gnome.Calculator\").",
      }),
    }),
    execute: async (_toolCallId, params: { app_name: string }) => {
      const proc = Bun.spawn([pythonBin, "-c", buildWalkerScript(params.app_name, maxDepth, maxNodes), JSON.stringify(params.app_name)], {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      });
      const timer = setTimeout(() => proc.kill(), timeoutMs);
      let stdout: string;
      let stderr: string;
      try {
        [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        await proc.exited;
      } finally {
        clearTimeout(timer);
      }

      let parsed: {
        error?: string;
        detail?: string;
        applications?: string[];
        application?: string;
        tree?: AtspiNode;
      };
      try {
        parsed = JSON.parse(stdout.trim());
      } catch {
        return textResult(
          `atspi_read failed: the AT-SPI walker produced no result${stderr.trim() ? ` (${stderr.trim().slice(0, 200)})` : ""}.`,
        );
      }

      if (parsed.error === "atspi_unavailable") {
        return textResult(
          `atspi_unavailable: the AT-SPI Python bindings are not usable (${parsed.detail ?? "no detail"}). ` +
            "Native structured access is not available on this machine.",
        );
      }
      if (parsed.error === "app_not_found") {
        const known = (parsed.applications ?? []).filter(Boolean).join(", ");
        return textResult(
          `app_not_found: no AT-SPI application named "${params.app_name}".${known ? ` Running applications: ${known}.` : " The accessibility bus reports no applications."}`,
        );
      }
      if (!parsed.tree) {
        return textResult("atspi_read failed: empty accessibility tree.");
      }
      return textResult(
        JSON.stringify({ application: parsed.application, tree: parsed.tree }),
      );
    },
  };

  return [read];
}
