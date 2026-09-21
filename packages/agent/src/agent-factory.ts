import { Agent, convertToLlm, type StreamFn } from "@earendil-works/pi-agent-core";
import { getBuiltinModel, getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { Model } from "@earendil-works/pi-ai";
import type { Env } from "./env.ts";
import { createOrgTools } from "./tools/org.ts";
import { createSkillsTools } from "./tools/skills.ts";
import { createSkillManageTool } from "./tools/skill-manage.ts";
import { createMemoryTool } from "./tools/memory.ts";
import { createSessionSearchTool } from "./tools/session-search.ts";
import { createCompositorTools } from "./tools/compositor.ts";
import { createBrowserTools } from "./tools/browser.ts";
import { createAtspiTools } from "./tools/atspi.ts";
import { createFsTools } from "./tools/fs.ts";
import { createDeliverTools } from "./tools/deliver.ts";
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

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/// Parses STAKA_FS_ALLOWLIST ("~/reports:/srv/share,~/docs").
export function parseAllowlist(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(/[:,]/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

function resolveModel(env: Env): Model | undefined {
  const provider = env.STAKA_MODEL_PROVIDER ?? "anthropic";
  const modelId = env.STAKA_MODEL_ID ?? getBuiltinModels(provider as never)[0]?.id;
  const builtin = getBuiltinModel(provider as never, modelId as never);
  if (builtin) return builtin;
  if (provider === "openrouter" && modelId) {
    // Model IDs published after the bundled catalog still work through the
    // OpenAI-compatible endpoint; cost stays zero because usage billing is
    // handled by the provider account.
    return {
      id: modelId,
      name: modelId,
      api: "openai-completions",
      provider: "openrouter",
      baseUrl: env.STAKA_MODEL_BASE_URL ?? OPENROUTER_BASE_URL,
      compat: {
        supportsDeveloperRole: false,
        thinkingFormat: "openrouter",
        requiresReasoningContentOnAssistantMessages: true,
      },
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: env.STAKA_MODEL_CONTEXT_WINDOW ?? 131_072,
      maxTokens: env.STAKA_MODEL_MAX_TOKENS ?? 8_192,
    };
  }
  return builtin;
}

function buildSystemPrompt(orgName?: string | null, skills?: SourcedSkill[]): string {
  const org = orgName ? `Organisation: ${orgName}.` : "Organisation: (unknown).";
  const parts = [
    "You are the Staka organisational desktop assistant.",
    org,
    "Use the org tools to answer questions about the current machine and the org directory.",
    "Prefer org_whoami for identity questions and org_users_search to find colleagues.",
    "Use org_log_event to record notable agent actions.",
    "Structured access ladder: prefer org tools (native API), then browser_* over CDP and atspi_read for structured app access.",
    "The user's display and input are never taken over: browser tools talk to the page, not the seat; headless work happens via compositor_* tools.",
    "If a tool reports a target as unreachable, say so plainly to the user; never invent results and never fall back to screenshots silently.",
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
  const compositorTools = createCompositorTools();
  const browserTools = createBrowserTools({
    profileDir: deps.env.STAKA_BROWSER_PROFILE_DIR,
    chromiumBin: deps.env.STAKA_CHROMIUM_BIN,
  });
  const atspiTools = createAtspiTools();
  const fsTools = createFsTools({
    allowlist: parseAllowlist(deps.env.STAKA_FS_ALLOWLIST),
    orgUrl: deps.orgUrl,
    token: deps.token,
    fetch: deps.fetch,
  });
  const deliverTools = createDeliverTools({
    orgUrl: deps.orgUrl,
    token: deps.token,
    fetch: deps.fetch,
  });
  const tools = [
    ...orgTools,
    ...skillsTools,
    skillManageTool,
    memoryTool,
    sessionSearchTool,
    ...compositorTools,
    ...browserTools,
    ...atspiTools,
    ...fsTools,
    ...deliverTools,
  ];
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
