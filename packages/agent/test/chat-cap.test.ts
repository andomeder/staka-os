import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { chatRoutes, MAX_MESSAGE_CHARS } from "../src/api/routes.ts";

function makeApp() {
  const app = new Hono();
  // The cap check runs before the agent is created, so a throwing factory
  // proves the cap fires first.
  app.route(
    "/",
    chatRoutes({
      makeAgent: () => {
        throw new Error("agent must not be created for an oversized message");
      },
    }),
  );
  return app;
}

describe("POST /chat payload cap", () => {
  test("rejects messages over the cap with 413", async () => {
    const res = await makeApp().request("/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "x".repeat(MAX_MESSAGE_CHARS + 1) }),
    });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toBe("message_too_long");
    expect(body.max_chars).toBe(MAX_MESSAGE_CHARS);
  });

  test("an oversized message never reaches the agent factory", async () => {
    const res = await makeApp().request("/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: `${"y".repeat(30_000)}\n  ` }),
    });
    expect(res.status).toBe(413);
  });
});
