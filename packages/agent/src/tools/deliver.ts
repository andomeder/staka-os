import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

/**
 * org_deliver: record that the agent produced or fetched something for a
 * named colleague. Backed by POST /v1/deliveries (machine JWT). Delivery is
 * an org-visible event (admin dashboard row + usage log), not an email
 * transport.
 */

export type DeliverToolsDeps = {
  orgUrl: string;
  token: string;
  fetch?: typeof fetch;
};

function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: {},
  };
}

export function createDeliverTools(deps: DeliverToolsDeps): AgentTool[] {
  const doFetch = deps.fetch ?? fetch;
  const base = deps.orgUrl.replace(/\/$/, "");
  const authHeaders = () => ({
    authorization: `Bearer ${deps.token}`,
    "content-type": "application/json",
  });

  const deliver: AgentTool = {
    name: "org_deliver",
    label: "Org deliver",
    description:
      "Deliver a summary (and optional artifact reference) to a colleague by employee id. " +
      "Resolve the employee id with org_users_search first; the delivery is recorded on the org server and visible to admins.",
    parameters: Type.Object({
      to_employee_id: Type.String({
        description: "Recipient's employee id, e.g. EMP-0042.",
      }),
      summary: Type.String({ description: "What is being delivered and why." }),
      artifact_ref: Type.Optional(
        Type.String({
          description: "Reference to the delivered artifact (file path, URL, figure id).",
        }),
      ),
    }),
    execute: async (
      _toolCallId,
      params: {
        to_employee_id: string;
        summary: string;
        artifact_ref?: string;
      },
    ) => {
      const res = await doFetch(`${base}/v1/deliveries`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          to_employee_id: params.to_employee_id,
          summary: params.summary,
          ...(params.artifact_ref
            ? { artifact_ref: params.artifact_ref }
            : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const code = (body as { error?: string }).error;
        if (code === "user_not_found") {
          return textResult(
            `org_deliver failed (user_not_found): no org member with employee id ${params.to_employee_id}. Re-check with org_users_search.`,
          );
        }
        throw new Error(
          `org_deliver failed: ${res.status} ${JSON.stringify(body)}`,
        );
      }
      const delivery = body as {
        id: string;
        to_user?: { employee_id: string; display_name: string };
      };
      return textResult(
        JSON.stringify({
          delivery_id: delivery.id,
          to: delivery.to_user ?? params.to_employee_id,
          summary: params.summary,
        }),
      );
    },
  };

  return [deliver];
}
