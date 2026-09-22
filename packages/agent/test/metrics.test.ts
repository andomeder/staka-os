import { describe, expect, test } from "bun:test";
import { createMetrics } from "../src/metrics.ts";

describe("agent metrics registry", () => {
  test("renders counters and uptime in prometheus text format", () => {
    const start = 1_000_000;
    const metrics = createMetrics(start);
    metrics.incChat();
    metrics.incChat();
    metrics.addTokens(120, 45);
    metrics.incToolCall("browser_click");
    metrics.incToolCall("org_whoami");
    metrics.incToolCall("browser_click");

    const text = metrics.render(start + 90_000);
    expect(text).toContain("staka_agent_chats_total 2");
    expect(text).toContain("staka_agent_tokens_input_total 120");
    expect(text).toContain("staka_agent_tokens_output_total 45");
    expect(text).toContain('staka_agent_tool_calls_total{tool="browser_click"} 2');
    expect(text).toContain('staka_agent_tool_calls_total{tool="org_whoami"} 1');
    expect(text).toContain("staka_agent_uptime_seconds 90");
    expect(text).toContain("# TYPE staka_agent_chats_total counter");
    expect(text.endsWith("\n")).toBe(true);
  });

  test("escapes label values", () => {
    const metrics = createMetrics(0);
    metrics.incToolCall('weird"tool\\name');
    const text = metrics.render(0);
    expect(text).toContain('tool="weird\\"tool\\\\name"');
  });

  test("clamps negative uptime to zero", () => {
    const metrics = createMetrics(10_000);
    expect(metrics.render(0)).toContain("staka_agent_uptime_seconds 0");
  });
});
