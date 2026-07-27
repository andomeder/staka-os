import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app.ts";

describe("health routes", () => {
  test("GET /v1/health returns 200", async () => {
    const app = createApp();
    const res = await app.request("/v1/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Request-Id")).toBeTruthy();
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test("GET /v1/ready reports db up when check passes", async () => {
    const app = createApp({ checkDb: async () => true });
    const res = await app.request("/v1/ready");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, db: "up" });
  });

  test("GET /v1/ready is 503 when db check fails", async () => {
    const app = createApp({ checkDb: async () => false });
    const res = await app.request("/v1/ready");
    expect(res.status).toBe(503);
  });

  test("GET /v1/config is 404 without machine auth deps", async () => {
    const app = createApp();
    const res = await app.request("/v1/config");
    expect(res.status).toBe(404);
  });
});
