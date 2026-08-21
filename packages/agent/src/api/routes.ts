import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Agent } from "@earendil-works/pi-agent-core";
import type { AgentEvent as ProtocolEvent } from "@staka/protocol";

export type ChatDeps = {
  makeAgent: () => Agent;
};

function summarizeResult(result: unknown): string {
  try {
    const content = (result as { content?: { type: string; text?: string }[] } | null)?.content;
    if (Array.isArray(content)) {
      const text = content
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join(" ");
      return text.slice(0, 500);
    }
    return JSON.stringify(result).slice(0, 500);
  } catch {
    return "";
  }
}

export function chatRoutes(deps: ChatDeps) {
  const app = new Hono();

  app.post("/chat", async (c) => {
    let body: { message?: unknown; session_id?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_body" }, 400);
    }
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) {
      return c.json({ error: "invalid_body" }, 400);
    }

    const agent = deps.makeAgent();

    return streamSSE(c, async (stream) => {
      const send = (evt: ProtocolEvent) =>
        stream.writeSSE({ data: JSON.stringify(evt), event: "message" });

      let tokensIn = 0;
      let tokensOut = 0;

      const unsubscribe = agent.subscribe((event) => {
        switch (event.type) {
          case "message_update": {
            const inner = event.assistantMessageEvent;
            if (inner.type === "text_delta") {
              send({ type: "text_delta", content: inner.delta });
            }
            break;
          }
          case "tool_execution_start":
            send({ type: "tool_call_start", name: event.toolName, args: event.args ?? {} });
            break;
          case "tool_execution_end":
            send({
              type: "tool_call_end",
              name: event.toolName,
              result_summary: summarizeResult(event.result),
            });
            break;
          case "agent_end": {
            for (const m of event.messages) {
              const usage = (m as { role?: string; usage?: { input?: number; output?: number } })
                .usage;
              if (m.role === "assistant" && usage) {
                tokensIn += usage.input ?? 0;
                tokensOut += usage.output ?? 0;
              }
            }
            break;
          }
          default:
            break;
        }
      });

      try {
        await agent.prompt(message);
        await agent.waitForIdle();
        const errMsg = agent.state.errorMessage;
        if (errMsg) {
          await send({ type: "error", message: errMsg });
        }
        await send({ type: "done", tokens_in: tokensIn, tokens_out: tokensOut });
      } catch (err) {
        await send({ type: "error", message: err instanceof Error ? err.message : String(err) });
        await send({ type: "done" });
      } finally {
        unsubscribe();
      }
    });
  });

  return app;
}
