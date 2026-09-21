import type { AgentTool } from "@earendil-works/pi-agent-core";
import { join } from "node:path";
import { createBrowserTools } from "../tools/browser.ts";
import { createCompositorTools } from "../tools/compositor.ts";
import { createFsTools } from "../tools/fs.ts";
import { createDeliverTools } from "../tools/deliver.ts";
import { createOrgTools } from "../tools/org.ts";
import { createMemoryTool } from "../tools/memory.ts";

/**
 * The demo walkthrough: the section-09 scenario wired end to end.
 *
 *   selection -> spreadsheet on the headless workspace -> local file read
 *   -> colleague resolve -> org delivery -> memory.
 *
 * The runner drives the same tool objects the agent uses. Its contract is
 * the graceful-failure one: every access layer reports "cannot reach
 * target" honestly, degrades the demo (never fakes a result), and the
 * degradation is visible in the step report.
 */

export type WalkthroughStatus = "ok" | "degraded" | "failed";

export type WalkthroughStep = {
  step: number;
  name: string;
  tool: string;
  status: WalkthroughStatus;
  detail: string;
};

export type WalkthroughInputs = {
  /// Expect this selection on the dashboard page (the demo figure).
  expectedSelection?: string;
  /// Text entered into the spreadsheet cell (defaults to the selection).
  figure?: string;
  /// Directory query for the colleague search.
  colleagueQuery?: string;
  /// Allowlisted directory containing the report file.
  reportDir?: string;
  reportFile?: string;
};

export type WalkthroughToolsets = {
  browser?: AgentTool[];
  compositor?: AgentTool[];
  org?: AgentTool[];
  fs?: AgentTool[];
  deliver?: AgentTool[];
  memory?: AgentTool[];
};

export type WalkthroughDeps = WalkthroughInputs & {
  orgUrl: string;
  token: string;
  fetch?: typeof fetch;
  toolsets?: WalkthroughToolsets;
};

function textOf(result: { content: Array<{ type: string; text?: string }> }) {
  return result.content[0]?.text ?? "";
}

function toolByName(tools: AgentTool[] | undefined, name: string): AgentTool {
  const list = tools ?? [];
  const tool = list.find((t) => t.name === name);
  if (!tool) {
    throw new Error(`missing tool: ${name}`);
  }
  return tool;
}

function isJson(text: string): boolean {
  const t = text.trim();
  return t.startsWith("{") || t.startsWith("[");
}

export function defaultToolsets(deps: {
  orgUrl: string;
  token: string;
  fetch?: typeof fetch;
  allowlist: string[];
}): WalkthroughToolsets {
  return {
    browser: createBrowserTools(),
    compositor: createCompositorTools(),
    org: createOrgTools({ orgUrl: deps.orgUrl, token: deps.token, fetch: deps.fetch }),
    fs: createFsTools({
      allowlist: deps.allowlist,
      orgUrl: deps.orgUrl,
      token: deps.token,
      fetch: deps.fetch,
    }),
    deliver: createDeliverTools({ orgUrl: deps.orgUrl, token: deps.token, fetch: deps.fetch }),
    memory: [createMemoryTool()],
  };
}

export async function runWalkthrough(deps: WalkthroughDeps): Promise<WalkthroughStep[]> {
  const toolsets =
    deps.toolsets ??
    defaultToolsets({
      orgUrl: deps.orgUrl,
      token: deps.token,
      fetch: deps.fetch,
      allowlist: deps.reportDir ? [deps.reportDir] : [],
    });
  const steps: WalkthroughStep[] = [];
  let figure = deps.figure ?? "";
  let colleague: { employee_id: string; display_name: string } | null = null;
  let deliverySummary = "";

  // 1. Capture the user's selection from the Staka-managed browser.
  const selectionResult = await toolByName(toolsets.browser, "browser_get_selection").execute("w1", {});
  const selectionText = textOf(selectionResult);
  if (isJson(selectionText)) {
    const selection = JSON.parse(selectionText) as { text?: string };
    figure = figure || selection.text || "";
    steps.push({
      step: 1,
      name: "capture selection",
      tool: "browser_get_selection",
      status: selection.text ? "ok" : "degraded",
      detail: selection.text
        ? `Selected: "${selection.text}"`
        : "No selection on the page; the user pasted the figure instead.",
    });
  } else {
    steps.push({
      step: 1,
      name: "capture selection",
      tool: "browser_get_selection",
      status: "degraded",
      detail: selectionText,
    });
  }
  if (!figure) {
    figure = "unknown figure";
  }

  // 2. Open the headless workspace and put the figure into a spreadsheet.
  const statusResult = await toolByName(toolsets.compositor, "compositor_status").execute("w2", {});
  const statusText = textOf(statusResult);
  if (statusText.includes("running and Hyprland is reachable")) {
    const startResult = await toolByName(toolsets.compositor, "compositor_start_app").execute(
      "w3",
      { app: "spreadsheet" },
    );
    const startText = textOf(startResult);
    const started = startText.includes("Started");
    steps.push({
      step: 2,
      name: "open headless spreadsheet",
      tool: "compositor_start_app",
      status: started ? "ok" : "failed",
      detail: startText,
    });
    if (started) {
      const typeResult = await toolByName(toolsets.compositor, "compositor_type").execute("w4", {
        text: figure,
      });
      steps.push({
        step: 3,
        name: "enter figure",
        tool: "compositor_type",
        status: textOf(typeResult).includes("Typed") ? "ok" : "failed",
        detail: textOf(typeResult),
      });
    }
  } else {
    steps.push({
      step: 2,
      name: "open headless spreadsheet",
      tool: "compositor_status",
      status: "degraded",
      detail: `${statusText} Falling back to delivering the figure as text; the user's display is untouched either way.`,
    });
  }

  // 4. Read the related local report file (sandboxed, audited).
  if (deps.reportFile) {
    const readResult = await toolByName(toolsets.fs, "fs_read_file").execute("w5", {
      path: deps.reportFile,
    });
    const readText = textOf(readResult);
    const ok = isJson(readText);
    steps.push({
      step: 4,
      name: "read report file",
      tool: "fs_read_file",
      status: ok ? "ok" : "failed",
      detail: ok
        ? `Read ${JSON.parse(readText).size} bytes from ${deps.reportFile}.`
        : readText,
    });
  }

  // 5. Resolve the colleague from the org directory.
  const query = deps.colleagueQuery ?? "John";
  const searchResult = await toolByName(toolsets.org, "org_users_search").execute("w6", {
    query,
  });
  const searchText = textOf(searchResult);
  if (isJson(searchText)) {
    const body = JSON.parse(searchText) as {
      users?: Array<{ employee_id: string; display_name: string }>;
      count?: number;
    };
    const users = body.users ?? [];
    if (users.length === 1) {
      colleague = users[0]!;
      steps.push({
        step: 5,
        name: "resolve colleague",
        tool: "org_users_search",
        status: "ok",
        detail: `Resolved ${colleague.display_name} (${colleague.employee_id}).`,
      });
    } else if (users.length === 0) {
      steps.push({
        step: 5,
        name: "resolve colleague",
        tool: "org_users_search",
        status: "failed",
        detail: `No org member matches "${query}". Delivery not attempted.`,
      });
    } else {
      steps.push({
        step: 5,
        name: "resolve colleague",
        tool: "org_users_search",
        status: "degraded",
        detail: `"${query}" is ambiguous (${users.length} matches: ${users
          .map((u) => `${u.display_name} ${u.employee_id}`)
          .join("; ")}). Ask the user to pick one; delivery not attempted.`,
      });
    }
  } else {
    steps.push({
      step: 5,
      name: "resolve colleague",
      tool: "org_users_search",
      status: "failed",
      detail: searchText,
    });
  }

  // 6. Deliver.
  if (colleague) {
    deliverySummary = `${figure} plus the Q3 report, prepared on the agent workspace`;
    const deliverResult = await toolByName(toolsets.deliver, "org_deliver").execute("w7", {
      to_employee_id: colleague.employee_id,
      summary: deliverySummary,
      ...(deps.reportFile ? { artifact_ref: deps.reportFile } : {}),
    });
    const deliverText = textOf(deliverResult);
    const ok = isJson(deliverText);
    steps.push({
      step: 6,
      name: "deliver",
      tool: "org_deliver",
      status: ok ? "ok" : "failed",
      detail: ok
        ? `Delivery ${JSON.parse(deliverText).delivery_id} recorded for ${colleague.display_name}.`
        : deliverText,
    });
  }

  // 7. Remember the interaction.
  const memoryResult = await toolByName(toolsets.memory, "memory").execute("w8", {
    action: "add",
    target: "memory",
    content: colleague
      ? `Delivered ${figure} to ${colleague.display_name} (${colleague.employee_id}).`
      : `Prepared ${figure}; delivery pending colleague resolution.`,
  });
  steps.push({
    step: 7,
    name: "remember",
    tool: "memory",
    status: textOf(memoryResult).includes('"ok":true') ? "ok" : "failed",
    detail: textOf(memoryResult),
  });

  return steps;
}

/// One-line-per-step report used by the CLI runner.
export function formatSteps(steps: WalkthroughStep[]): string {
  return steps
    .map((s) => {
      const marker =
        s.status === "ok" ? "[ok]" : s.status === "degraded" ? "[degraded]" : "[failed]";
      return `${marker} step ${s.step} (${s.name}) via ${s.tool}: ${s.detail}`;
    })
    .join("\n");
}

export const demoPaths = {
  dashboard: join(import.meta.dir ?? ".", "demo-dashboard.html"),
  report: join(import.meta.dir ?? ".", "demo-report.txt"),
};
