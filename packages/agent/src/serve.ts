import { Hono } from "hono";
import type { Env } from "./env.ts";
import { bootstrap, startHeartbeat } from "./bootstrap.ts";
import { pullConfig } from "./config-pull.ts";
import { chatRoutes } from "./api/routes.ts";
import { createAgent, resolveModel } from "./agent-factory.ts";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { loadSkills, type SourcedSkill } from "./skills/loader.ts";
import { ensureOrgSkillSymlink } from "./skills/symlink.ts";
import { syncSkillPack } from "./skills/pack-sync.ts";
import { shouldRunCurator, runCurator } from "./skills/curator.ts";
import { getSnapshot } from "./memory/personal.ts";
import { startResumeWatcher } from "./resume.ts";

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
  skills?: SourcedSkill[];
};

export function createApp(state: AgentState, chat?: ChatConfig, skills?: SourcedSkill[]) {
  const app = new Hono();

  app.get("/health", (c) => {
    const snapshot = getSnapshot();
    const memoryEntries = (snapshot.memory ? snapshot.memory.split("§").filter((e) => e.trim()).length : 0) +
      (snapshot.user ? snapshot.user.split("§").filter((e) => e.trim()).length : 0);
    return c.json({
      status: state.status,
      machine_id: state.machineId,
      org_name: state.orgName,
      model: chat ? resolveModel(chat.env)?.id ?? null : null,
      skills_count: skills?.length ?? 0,
      memory_entries: memoryEntries,
      error: state.error,
    });
  });

  if (chat) {
    app.route("/", chatRoutes({ makeAgent: () => createAgent({ ...chat, skills }) }));
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
  let skills: SourcedSkill[] = [];

  try {
    const boot = await bootstrap(env);
    state.machineId = boot.machineId;
    state.orgUrl = boot.orgUrl;

    const config = await pullConfig(boot.orgUrl, boot.token, env);
    state.orgName = config.org_name;
    state.configVersion = config.version;
    state.status = "active";

    const pack = await syncSkillPack(env, boot.orgUrl, boot.token, config);
    if (pack.updated) {
      console.log(
        `skill pack updated: ${pack.skillCount} skills at ${pack.path}`,
      );
    } else if (pack.reason === "hash_mismatch" || pack.reason === "invalid_pack") {
      console.error(`skill pack sync refused: ${pack.reason}`);
    }

    ensureOrgSkillSymlink();
    const loaded = await loadSkills();
    skills = loaded.skills;
    if (loaded.diagnostics.length > 0) {
      console.warn("skills diagnostics:", loaded.diagnostics);
    }

    if (shouldRunCurator()) {
      const result = runCurator();
      if (result.archived.length > 0) {
        console.log("curator archived:", result.archived);
      }
    }

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

  const app = createApp(state, chat, skills);

  const resumeWatcher = startResumeWatcher({
    log: (message) => console.log(message),
  });

  const server = Bun.serve({
    hostname: env.STAKA_AGENT_HOST,
    port: env.STAKA_AGENT_PORT,
    fetch: app.fetch,
  });

  console.log(`staka-agent listening on ${server.hostname}:${server.port} (status: ${state.status}, skills: ${skills.length})`);

  return () => resumeWatcher.stop();
}
