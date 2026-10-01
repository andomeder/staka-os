/**
 * Agent metrics in Prometheus text format, served on the existing
 * loopback API at /metrics.
 *
 * Deliberately dependency-free: a handful of counters and one gauge, in
 * the standard exposition format. The agent API is loopback-only, so the
 * endpoint is on by default and costs nothing; whether a Prometheus scrapes
 * it is a deployment decision (see deploy/README.md - by default it does
 * not, org-server logs remain the system of record).
 */

export type AgentMetrics = {
  incChat(): void;
  addTokens(input: number, output: number): void;
  incToolCall(tool: string): void;
  render(nowMs?: number): string;
};

export type MetricsState = {
  chats: number;
  tokensInput: number;
  tokensOutput: number;
  toolCalls: Map<string, number>;
  startedAtMs: number;
};

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

export function createMetrics(nowMs: number = Date.now()): AgentMetrics {
  const state: MetricsState = {
    chats: 0,
    tokensInput: 0,
    tokensOutput: 0,
    toolCalls: new Map(),
    startedAtMs: nowMs,
  };

  return {
    incChat() {
      state.chats += 1;
    },
    addTokens(input, output) {
      state.tokensInput += input;
      state.tokensOutput += output;
    },
    incToolCall(tool) {
      state.toolCalls.set(tool, (state.toolCalls.get(tool) ?? 0) + 1);
    },
    render(now = Date.now()) {
      const uptimeSeconds = Math.max(0, Math.floor((now - state.startedAtMs) / 1000));
      const lines: string[] = [];

      lines.push("# HELP staka_agent_chats_total Completed agent conversations.");
      lines.push("# TYPE staka_agent_chats_total counter");
      lines.push(`staka_agent_chats_total ${state.chats}`);

      lines.push("# HELP staka_agent_tokens_input_total Model input tokens consumed.");
      lines.push("# TYPE staka_agent_tokens_input_total counter");
      lines.push(`staka_agent_tokens_input_total ${state.tokensInput}`);

      lines.push("# HELP staka_agent_tokens_output_total Model output tokens produced.");
      lines.push("# TYPE staka_agent_tokens_output_total counter");
      lines.push(`staka_agent_tokens_output_total ${state.tokensOutput}`);

      lines.push("# HELP staka_agent_tool_calls_total Tool executions by tool name.");
      lines.push("# TYPE staka_agent_tool_calls_total counter");
      for (const [tool, count] of [...state.toolCalls.entries()].sort()) {
        lines.push(`staka_agent_tool_calls_total{tool="${escapeLabel(tool)}"} ${count}`);
      }

      lines.push("# HELP staka_agent_uptime_seconds Agent process uptime in seconds.");
      lines.push("# TYPE staka_agent_uptime_seconds gauge");
      lines.push(`staka_agent_uptime_seconds ${uptimeSeconds}`);

      return `${lines.join("\n")}\n`;
    },
  };
}

/** Process-wide registry used by the serving app. */
export const agentMetrics = createMetrics();
