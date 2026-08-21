import { Agent, convertToLlm, type StreamFn } from "@earendil-works/pi-agent-core";
import { getBuiltinModel, getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { Env } from "./env.ts";
import { createOrgTools } from "./tools/org.ts";
import { createSkillsTools } from "./tools/skills.ts";
import { createSkillManageTool } from "./tools/skill-manage.ts";
import { createMemoryTool } from "./tools/memory.ts";
import { createSessionSearchTool } from "./tools/session-search.ts";
import { buildMemoryPromptBlock } from "./memory/personal.ts";
import { buildSkillsIndex, type SourcedSkill } from "./skills/loader.ts";

export type CreateAgentDeps = {
  env: Env;
  orgUrl: string;
  token: string;
  orgName?: string | null;
  streamFn?: StreamFn;
  fetch?: typeof fetch;
  skills?: SourcedSkill[];
  sessionId?: string;
};

function resolveModel(env: Env) {
  const provider = env.STAKA_MODEL_PROVIDER ?? "anthropic";
  const modelId = env.STAKA_MODEL_ID ?? getBuiltinModels(provider as never)[0]?.id;
  return getBuiltinModel(provider as never, modelId as never);
}

function buildSystemPrompt(orgName?: string | null, skills?: SourcedSkill[]): string {
  const org = orgName ? `Organisation: ${orgName}.` : "Organisation: (unknown).";
  const parts = [
    "You are the Staka organisational desktop assistant.",
    org,
    "Use the org tools to answer questions about the current machine and the org directory.",
    "Prefer org_whoami for identity questions and org_users_search to find colleagues.",
    "Use org_log_event to record notable agent actions.",
  ];

  const memoryBlock = buildMemoryPromptBlock();
  if (memoryBlock) {
    parts.push("", memoryBlock);
  }

  if (skills && skills.length > 0) {
		const index = buildSkillsIndex(skills);
		if (index) {
			parts.push("", index);
		}
  }
  return parts.join("\n");
}

export function createAgent(deps: CreateAgentDeps): Agent {
  const orgTools = createOrgTools({
    orgUrl: deps.orgUrl,
    token: deps.token,
    fetch: deps.fetch,
  });
  const skills = deps.skills ?? [];
  const skillsTools = createSkillsTools({ getSkills: () => skills });
  const createsThisSession = { count: 0 };
  const skillManageTool = createSkillManageTool({
    sessionId: deps.sessionId ?? crypto.randomUUID(),
    createsThisSession,
  });
  const memoryTool = createMemoryTool();
  const sessionSearchTool = createSessionSearchTool();
  const tools = [...orgTools, ...skillsTools, skillManageTool, memoryTool, sessionSearchTool];
  return new Agent({
    initialState: {
      systemPrompt: buildSystemPrompt(deps.orgName, skills),
      model: resolveModel(deps.env),
      tools,
    },
    convertToLlm,
    streamFn: deps.streamFn ?? streamSimple,
    getApiKey: () => deps.env.STAKA_MODEL_API_KEY,
  });
}
