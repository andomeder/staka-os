import { Agent, convertToLlm, type StreamFn } from "@earendil-works/pi-agent-core";
import { getBuiltinModel, getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { Env } from "./env.ts";
import { createOrgTools } from "./tools/org.ts";

export type CreateAgentDeps = {
  env: Env;
  orgUrl: string;
  token: string;
  orgName?: string | null;
  streamFn?: StreamFn;
  fetch?: typeof fetch;
};

function resolveModel(env: Env) {
  const provider = env.STAKA_MODEL_PROVIDER ?? "anthropic";
  const modelId = env.STAKA_MODEL_ID ?? getBuiltinModels(provider as never)[0]?.id;
  return getBuiltinModel(provider as never, modelId as never);
}

function buildSystemPrompt(orgName?: string | null): string {
  const org = orgName ? `Organisation: ${orgName}.` : "Organisation: (unknown).";
  return [
    "You are the Staka organisational desktop assistant.",
    org,
    "Use the org tools to answer questions about the current machine and the org directory.",
    "Prefer org_whoami for identity questions and org_users_search to find colleagues.",
    "Use org_log_event to record notable agent actions.",
  ].join("\n");
}

export function createAgent(deps: CreateAgentDeps): Agent {
  const tools = createOrgTools({
    orgUrl: deps.orgUrl,
    token: deps.token,
    fetch: deps.fetch,
  });
  return new Agent({
    initialState: {
      systemPrompt: buildSystemPrompt(deps.orgName),
      model: resolveModel(deps.env),
      tools,
    },
    convertToLlm,
    streamFn: deps.streamFn ?? streamSimple,
    getApiKey: () => deps.env.STAKA_MODEL_API_KEY,
  });
}
