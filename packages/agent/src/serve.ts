import { Hono } from "hono";
import type { Env } from "./env.ts";
import { bootstrap, startHeartbeat } from "./bootstrap.ts";
import { pullConfig } from "./config-pull.ts";
import { chatRoutes } from "./api/routes.ts";
import { createAgent } from "./agent-factory.ts";
import type { StreamFn } from "@earendil-works/pi-agent-core";

export type AgentState = {
  status: "starting" | "active" | "degraded" | "suspended";
  machineId: string | null;
  orgName: string | null;
  orgUrl: string | null;
  configVersion: number | null;
  error: string | null;
};

export type ChatConfig = {
  env: Env;
  orgUrl: string;
  token: string;
  orgName?: string | null;
  streamFn?: StreamFn;
  fetch?: typeof fetch;
};

export function createApp(state: AgentState, chat?: ChatConfig) {
  const app = new Hono();

  app.get("/health", (c) => {
    return c.json({
      status: state.status,
      machine_id: state.machineId,
      org_name: state.orgName,
      model: null,
      skills_count: 0,
      memory_entries: 0,
      error: state.error,
    });
  });

  if (chat) {
    app.route("/", chatRoutes({ makeAgent: () => createAgent(chat) }));
  }

  return app;
}

export async function serve(env: Env) {
  const state: AgentState = {
    status: "starting",
    machineId: null,
    orgName: null,
    orgUrl: null,
    configVersion: null,
    error: null,
  };

  let chat: ChatConfig | undefined;

  try {
    const boot = await bootstrap(env);
    state.machineId = boot.machineId;
    state.orgUrl = boot.orgUrl;

    const config = await pullConfig(boot.orgUrl, boot.token, env);
    state.orgName = config.org_name;
    state.configVersion = config.version;
    state.status = "active";

    chat = {
      env,
      orgUrl: boot.orgUrl,
      token: boot.token,
      orgName: config.org_name,
    };

    startHeartbeat(
      boot.orgUrl,
      boot.token,
      env.STAKA_HEARTBEAT_INTERVAL_MS,
      (status) => {
        if (status === "suspended" || status === "revoked") {
          state.status = "suspended";
        }
      },
      (err) => {
        console.error("heartbeat error:", err.message);
      },
    );
  } catch (err) {
    state.status = "degraded";
    state.error = err instanceof Error ? err.message : String(err);
  }

  const app = createApp(state, chat);

  const server = Bun.serve({
    hostname: env.STAKA_AGENT_HOST,
    port: env.STAKA_AGENT_PORT,
    fetch: app.fetch,
  });

  console.log(`staka-agent listening on ${server.hostname}:${server.port} (status: ${state.status})`);
}
