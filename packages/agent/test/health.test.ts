import { describe, expect, test } from "bun:test";
import { createApp, type AgentState } from "../src/serve.ts";

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    status: "starting",
    machineId: null,
    orgName: null,
    orgUrl: null,
    configVersion: null,
    error: null,
    ...overrides,
  };
}

describe("GET /health", () => {
  test("returns starting state", async () => {
    const app = createApp(makeState());
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("starting");
    expect(body.machine_id).toBeNull();
    expect(body.org_name).toBeNull();
    expect(body.model).toBeNull();
    expect(body.skills_count).toBe(0);
    expect(body.memory_entries).toBe(0);
    expect(body.error).toBeNull();
  });

  test("returns active state with machine info", async () => {
    const app = createApp(
      makeState({
        status: "active",
        machineId: "m-123",
        orgName: "Acme Corp",
        orgUrl: "https://org.example.com",
        configVersion: 1,
      }),
    );
    const res = await app.request("/health");
    const body = await res.json();
    expect(body.status).toBe("active");
    expect(body.machine_id).toBe("m-123");
    expect(body.org_name).toBe("Acme Corp");
  });

  test("returns degraded state with error", async () => {
    const app = createApp(
      makeState({ status: "degraded", error: "token file missing" }),
    );
    const res = await app.request("/health");
    const body = await res.json();
    expect(body.status).toBe("degraded");
    expect(body.error).toBe("token file missing");
  });

  test("returns suspended state", async () => {
    const app = createApp(makeState({ status: "suspended" }));
    const res = await app.request("/health");
    const body = await res.json();
    expect(body.status).toBe("suspended");
  });
});
