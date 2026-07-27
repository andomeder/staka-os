import { describe, expect, test } from "bun:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createApp, type AgentState, type ChatConfig } from "../src/serve.ts";
import { loadEnv } from "../src/env.ts";

function makeAssistantMessage(text: string) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test-model",
    usage: {
      input: 3,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 5,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function mockStreamFn(text: string): StreamFn {
  return () => {
    const stream = createAssistantMessageEventStream();
    const final = makeAssistantMessage(text);
    stream.push({ type: "start", partial: { ...final, content: [] } });
    stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: final });
    stream.push({ type: "done", reason: "stop", message: final });
    return stream;
  };
}

const noNetworkFetch = (() => {
  throw new Error("network disabled in test");
}) as typeof fetch;

function makeState(): AgentState {
  return {
    status: "active",
    machineId: "m-1",
    orgName: "Acme Corp",
    orgUrl: "https://org.example",
    configVersion: 1,
    error: null,
  };
}

function makeChat(streamFn: StreamFn): ChatConfig {
  return {
    env: loadEnv(),
    orgUrl: "https://org.example",
    token: "test-token",
    orgName: "Acme Corp",
    streamFn,
    fetch: noNetworkFetch,
  };
}

describe("POST /chat", () => {
  test("streams text deltas and a done event", async () => {
    const app = createApp(makeState(), makeChat(mockStreamFn("hello world")));

    const res = await app.request("/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('"type":"text_delta"');
    expect(body).toContain("hello world");
    expect(body).toContain('"type":"done"');
  });

  test("done event carries token usage from assistant messages", async () => {
    const app = createApp(makeState(), makeChat(mockStreamFn("usage check")));

    const res = await app.request("/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });

    const body = await res.text();
    expect(body).toContain('"tokens_in":3');
    expect(body).toContain('"tokens_out":2');
  });

  test("rejects an empty message with 400", async () => {
    const app = createApp(makeState(), makeChat(mockStreamFn("unused")));

    const res = await app.request("/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "   " }),
    });

    expect(res.status).toBe(400);
  });

  test("rejects malformed JSON with 400", async () => {
    const app = createApp(makeState(), makeChat(mockStreamFn("unused")));

    const res = await app.request("/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });

    expect(res.status).toBe(400);
  });
});
