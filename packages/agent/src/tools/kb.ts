import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

export type KbToolsDeps = {
  orgUrl: string;
  token: string;
  fetch?: typeof fetch;
};

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: {},
  };
}

export function createKbTools(deps: KbToolsDeps): AgentTool[] {
  const doFetch = deps.fetch ?? fetch;
  const base = deps.orgUrl.replace(/\/$/, "");
  const authHeaders = () => ({
    authorization: `Bearer ${deps.token}`,
    "content-type": "application/json",
  });

  async function postJson<T>(path: string, body: unknown): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(
        `kb_unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      if (res.status === 503) {
        throw new Error("kb_unavailable: knowledge base engine is down");
      }
      throw new Error(`${path} failed: ${res.status} ${JSON.stringify(parsed)}`);
    }
    return parsed as T;
  }

  const searchKnowledge: AgentTool = {
    name: "search_knowledge",
    label: "Search knowledge base",
    description:
      "Search the organisation knowledge base (procedures, policies, guides). Returns ranked document snippets with citations; follow up with get_document for the full text.",
    parameters: Type.Object({
      query: Type.String(),
      limit: Type.Optional(Type.Number()),
    }),
    execute: async (
      _toolCallId,
      params: { query: string; limit?: number },
    ) => {
      const body = await postJson("/v1/kb/search", {
        query: params.query,
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
      });
      return jsonResult(body);
    },
  };

  const searchSkills: AgentTool = {
    name: "search_skills",
    label: "Search org skills",
    description:
      "Search the organisation's shared skill packs. Returns matching skills with descriptions; the full skill instructions load through the normal skills surface.",
    parameters: Type.Object({
      query: Type.String(),
      limit: Type.Optional(Type.Number()),
    }),
    execute: async (
      _toolCallId,
      params: { query: string; limit?: number },
    ) => {
      const body = await postJson("/v1/kb/skills", {
        query: params.query,
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
      });
      return jsonResult(body);
    },
  };

  const whoKnows: AgentTool = {
    name: "who_knows",
    label: "Who knows a topic",
    description:
      "Find organisation members with documented knowledge of a topic, ranked by profile and document evidence. Prefer this over org_users_search when resolving 'who handles X'; fall back to org_users_search for plain name lookups.",
    parameters: Type.Object({
      topic: Type.String(),
      limit: Type.Optional(Type.Number()),
    }),
    execute: async (_toolCallId, params: { topic: string; limit?: number }) => {
      const body = await postJson("/v1/kb/who-knows", {
        topic: params.topic,
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
      });
      return jsonResult(body);
    },
  };

  const getDocument: AgentTool = {
    name: "get_document",
    label: "Get KB document",
    description:
      "Fetch the full text of a knowledge base document by the id returned from search_knowledge. Content is capped for context safety.",
    parameters: Type.Object({
      id: Type.String(),
    }),
    execute: async (_toolCallId, params: { id: string }) => {
      let res: Response;
      try {
        res = await doFetch(
          `${base}/v1/kb/documents/${encodeURIComponent(params.id)}`,
          { headers: { authorization: `Bearer ${deps.token}` } },
        );
      } catch (err) {
        throw new Error(
          `kb_unavailable: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        if (res.status === 503) {
          throw new Error("kb_unavailable: knowledge base engine is down");
        }
        throw new Error(
          `get_document failed: ${res.status} ${JSON.stringify(parsed)}`,
        );
      }
      return jsonResult(parsed);
    },
  };

  return [searchKnowledge, searchSkills, whoKnows, getDocument];
}
