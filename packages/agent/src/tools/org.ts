import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

export type OrgToolsDeps = {
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

export function createOrgTools(deps: OrgToolsDeps): AgentTool[] {
  const doFetch = deps.fetch ?? fetch;
  const base = deps.orgUrl.replace(/\/$/, "");
  const authHeaders = () => ({ authorization: `Bearer ${deps.token}` });

  const whoami: AgentTool = {
    name: "org_whoami",
    label: "Org whoami",
    description:
      "Return this machine's own org record and its bound user (employee id, display name, email, status, provision flow).",
    parameters: Type.Object({}),
    execute: async () => {
      const res = await doFetch(`${base}/v1/machines/me`, { headers: authHeaders() });
      const body = await res.json();
      if (!res.ok) {
        throw new Error(`org_whoami failed: ${res.status} ${JSON.stringify(body)}`);
      }
      return jsonResult(body);
    },
  };

  const usersSearch: AgentTool = {
    name: "org_users_search",
    label: "Org users search",
    description:
      "Search the org directory for people by employee id, display name, or email prefix. Returns non-PII profile fields.",
    parameters: Type.Object({
      query: Type.String(),
      limit: Type.Optional(Type.Number()),
    }),
    execute: async (_toolCallId, params: { query: string; limit?: number }) => {
      const url = new URL(`${base}/v1/users/search`);
      url.searchParams.set("q", params.query);
      if (params.limit != null) url.searchParams.set("limit", String(params.limit));
      const res = await doFetch(url.toString(), { headers: authHeaders() });
      const body = await res.json();
      if (!res.ok) {
        throw new Error(`org_users_search failed: ${res.status} ${JSON.stringify(body)}`);
      }
      return jsonResult(body);
    },
  };

  const logEvent: AgentTool = {
    name: "org_log_event",
    label: "Org log event",
    description:
      "Record an agent activity event to the org usage log. event_type must be one of agent_action, agent_error, skill_invoked.",
    parameters: Type.Object({
      event_type: Type.Union([
        Type.Literal("agent_action"),
        Type.Literal("agent_error"),
        Type.Literal("skill_invoked"),
      ]),
      detail: Type.Optional(Type.String()),
    }),
    execute: async (
      _toolCallId,
      params: { event_type: "agent_action" | "agent_error" | "skill_invoked"; detail?: string },
    ) => {
      const res = await doFetch(`${base}/v1/usage-logs`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify(params),
      });
      const body = await res.json();
      if (!res.ok) {
        throw new Error(`org_log_event failed: ${res.status} ${JSON.stringify(body)}`);
      }
      return jsonResult(body);
    },
  };

  return [whoami, usersSearch, logEvent];
}
