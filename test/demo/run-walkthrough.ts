#!/usr/bin/env bun
/**
 * Demo walkthrough runner: drives the full section-09 scenario through the
 * same tool objects the agent uses.
 *
 *   selection -> spreadsheet on the headless workspace -> local report read
 *   -> colleague resolve -> org delivery -> memory.
 *
 * Usage:
 *   ORG_URL=https://org.example TOKEN=$(cat /etc/staka/machine.token) \
 *   bun test/demo/run-walkthrough.ts
 *
 * Environment:
 *   ORG_URL, TOKEN        org server + machine JWT (required for org steps)
 *   STAKA_FS_ALLOWLIST    extra allowlist dirs; the demo report dir is added
 *   STAKA_DEMO_COLLEAGUE  colleague search query (default "John")
 *
 * Every degraded or failed step is printed honestly and the run continues
 * where meaningful; the exit code is 1 only if a step hard-fails.
 */

import { mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultToolsets,
  formatSteps,
  runWalkthrough,
  demoPaths,
} from "../../packages/agent/src/demo/walkthrough.ts";

const orgUrl = process.env.ORG_URL ?? "http://127.0.0.1:8080";
const token = process.env.TOKEN ?? "";

if (!token) {
  console.error(
    "TOKEN is required (the machine JWT from /etc/staka/machine.token or a lab token).",
  );
  process.exit(1);
}

// Stage the demo report into an allowlisted directory the agent can read.
const reportDir = process.env.STAKA_DEMO_REPORT_DIR ?? join(tmpdir(), "staka-demo");
mkdirSync(reportDir, { recursive: true });
const reportFile = join(reportDir, "q3-report.txt");
copyFileSync(demoPaths.report, reportFile);

const steps = await runWalkthrough({
  orgUrl,
  token,
  reportDir,
  reportFile,
  colleagueQuery: process.env.STAKA_DEMO_COLLEAGUE ?? "John",
  toolsets: defaultToolsets({
    orgUrl,
    token,
    allowlist: [reportDir],
  }),
});

console.log("Staka demo walkthrough:");
console.log(formatSteps(steps));

const failed = steps.filter((s) => s.status === "failed").length;
const degraded = steps.filter((s) => s.status === "degraded").length;
console.log(
  `\n${steps.length - failed - degraded} ok, ${degraded} degraded, ${failed} failed.` +
    (degraded > 0 ? " Degraded steps report honestly why; nothing was faked." : ""),
);
process.exit(failed > 0 ? 1 : 0);
