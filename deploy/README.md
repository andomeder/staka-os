# Deployment: metrics

## What is served

Every desktop agent serves Prometheus-format metrics on its existing
loopback API:

    http://127.0.0.1:7920/metrics

Counters: `staka_agent_chats_total`, `staka_agent_tokens_input_total`,
`staka_agent_tokens_output_total`, `staka_agent_tool_calls_total{tool}`.
Gauge: `staka_agent_uptime_seconds`.

The endpoint is on by default. It is loopback-only (the agent binds
127.0.0.1), costs nothing when unscraped, and needs no configuration.

## Deployment decision (gate)

A Prometheus + Grafana stack is **not** deployed by default. The org
server's structured logs remain the system of record for usage reporting;
the metrics endpoint exists so a monitoring stack can be attached to any
machine later without touching the agent.

If an operator wants dashboards:

1. Run Prometheus and Grafana (any host that can reach the machines).
2. Scrape each machine: `job: staka-agent`, target `machine:7920`.
   The agent API is loopback-only by design, so scraping happens over
   SSH tunnels or a local collector, never by opening the port.
3. Import `grafana-agent-dashboard.json` from this directory.

Revisit this gate only if the org server logs stop being sufficient for
usage reporting.
