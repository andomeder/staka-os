import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfigResponse } from "@staka/protocol";
import { cacheConfig, loadCachedConfig } from "../src/config-pull.ts";
import { loadEnv } from "../src/env.ts";

const VALID_CONFIG: ConfigResponse = {
  version: 1,
  org_name: "Test Org",
  features: { skills_sync: false, memory_sync: false },
  model: { provider: null, model_id: null, base_url: null },
  skill_pack_url: null,
  skill_pack_hash: null,
};

describe("cacheConfig + loadCachedConfig", () => {
  let dir: string;

  test("round-trips config through disk", async () => {
    dir = await mkdtemp(join(tmpdir(), "staka-cfg-"));
    const saved = process.env.STAKA_STATE_DIR;
    process.env.STAKA_STATE_DIR = dir;
    try {
      const env = loadEnv();
      await cacheConfig(env, VALID_CONFIG);
      const raw = await readFile(join(dir, "config.json"), "utf-8");
      expect(JSON.parse(raw)).toEqual(VALID_CONFIG);

      const loaded = await loadCachedConfig(env);
      expect(loaded).toEqual(VALID_CONFIG);
    } finally {
      if (saved === undefined) delete process.env.STAKA_STATE_DIR;
      else process.env.STAKA_STATE_DIR = saved;
      await rm(dir, { recursive: true });
    }
  });

  test("loadCachedConfig returns null when no cache", async () => {
    dir = await mkdtemp(join(tmpdir(), "staka-cfg-"));
    const saved = process.env.STAKA_STATE_DIR;
    process.env.STAKA_STATE_DIR = dir;
    try {
      const env = loadEnv();
      const loaded = await loadCachedConfig(env);
      expect(loaded).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.STAKA_STATE_DIR;
      else process.env.STAKA_STATE_DIR = saved;
      await rm(dir, { recursive: true });
    }
  });

  test("loadCachedConfig returns null on corrupt cache", async () => {
    dir = await mkdtemp(join(tmpdir(), "staka-cfg-"));
    const saved = process.env.STAKA_STATE_DIR;
    process.env.STAKA_STATE_DIR = dir;
    try {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(dir, "config.json"), "{invalid json");
      const env = loadEnv();
      const loaded = await loadCachedConfig(env);
      expect(loaded).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.STAKA_STATE_DIR;
      else process.env.STAKA_STATE_DIR = saved;
      await rm(dir, { recursive: true });
    }
  });
});

describe("pullConfig", () => {
  test("fetches and validates config from server", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/v1/config") {
          const auth = req.headers.get("authorization");
          if (auth !== "Bearer test-token") {
            return Response.json({ error: "unauthorized" }, { status: 401 });
          }
          return Response.json(VALID_CONFIG);
        }
        return new Response("not found", { status: 404 });
      },
    });

    try {
      const { pullConfig } = await import("../src/config-pull.ts");
      const dir = await mkdtemp(join(tmpdir(), "staka-pull-"));
      const saved = process.env.STAKA_STATE_DIR;
      process.env.STAKA_STATE_DIR = dir;
      try {
        const env = loadEnv();
        const orgUrl = `http://127.0.0.1:${server.port}`;
        const config = await pullConfig(orgUrl, "test-token", env);
        expect(config).toEqual(VALID_CONFIG);
      } finally {
        if (saved === undefined) delete process.env.STAKA_STATE_DIR;
        else process.env.STAKA_STATE_DIR = saved;
        await rm(dir, { recursive: true });
      }
    } finally {
      server.stop(true);
    }
  });

  test("throws on invalid config shape", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ bad: "shape" });
      },
    });

    try {
      const { pullConfig } = await import("../src/config-pull.ts");
      const dir = await mkdtemp(join(tmpdir(), "staka-pull-"));
      const saved = process.env.STAKA_STATE_DIR;
      process.env.STAKA_STATE_DIR = dir;
      try {
        const env = loadEnv();
        const orgUrl = `http://127.0.0.1:${server.port}`;
        await expect(pullConfig(orgUrl, "tok", env)).rejects.toThrow();
      } finally {
        if (saved === undefined) delete process.env.STAKA_STATE_DIR;
        else process.env.STAKA_STATE_DIR = saved;
        await rm(dir, { recursive: true });
      }
    } finally {
      server.stop(true);
    }
  });
});
