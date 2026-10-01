import { describe, expect, test } from "bun:test";
import { createApp, type AgentState } from "../src/serve.ts";
import { agentMetrics } from "../src/metrics.ts";

function makeState(): AgentState {
  return {
    status: "active",
    machineId: "m-1",
    orgName: "Acme Corp",
    orgUrl: "https://org.example",
    configVersion: 1,
    error: null,
  };
}

describe("GET /metrics", () => {
  test("serves prometheus text format", async () => {
    const app = createApp(makeState());
    const res = await app.request("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain("staka_agent_chats_total ");
    expect(body).toContain("staka_agent_uptime_seconds ");
    expect(body).toContain("# TYPE staka_agent_uptime_seconds gauge");
  });

  test("counters advance as chats are recorded", async () => {
    agentMetrics.incChat();
    agentMetrics.incToolCall("org_whoami");
    const app = createApp(makeState());
    const res = await app.request("/metrics");
    const body = await res.text();
    expect(body).toContain('staka_agent_tool_calls_total{tool="org_whoami"} 1');
  });
});
