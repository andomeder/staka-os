import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentEvent as ProtocolEvent } from "@staka/protocol";

export type ChatDeps = {
  makeAgent: (history?: AgentMessage[]) => Agent;
};

/** Maximum prior turns replayed as conversation context. */
const MAX_HISTORY_TURNS = 24;

type HistoryTurn = { role: unknown; content: unknown };

/**
 * Rebuild provider-shaped messages from the caller's transcript so each
 * /chat call continues its session instead of starting cold. Only plain
 * user/assistant text turns are replayed; tool traffic stays out.
 */
function seedHistory(raw: unknown): AgentMessage[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const turns = raw.filter(
    (t): t is HistoryTurn =>
      typeof t === "object" &&
      t !== null &&
      ((t as HistoryTurn).role === "user" || (t as HistoryTurn).role === "assistant") &&
      typeof (t as HistoryTurn).content === "string" &&
      ((t as HistoryTurn).content as string).trim().length > 0,
  );
  if (turns.length === 0) return undefined;
  const recent = turns.slice(-MAX_HISTORY_TURNS);
  const base = Date.now() - recent.length * 1000;
  const messages = recent.map((t, i) => {
    if (t.role === "user") {
      return { role: "user", content: t.content as string, timestamp: base + i * 1000 };
    }
    return {
      role: "assistant",
      content: [{ type: "text", text: t.content as string }],
      api: "openai-completions",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
      timestamp: base + i * 1000,
    } as AgentMessage;
  });
  return messages;
}

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
    let body: { message?: unknown; session_id?: unknown; history?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_body" }, 400);
    }
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) {
      return c.json({ error: "invalid_body" }, 400);
    }

    const agent = deps.makeAgent(seedHistory(body.history));

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
