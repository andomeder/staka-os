import { afterAll, describe, expect, test } from "bun:test";
import {
  KbEngineClient,
  KbEngineError,
  KbUnavailableError,
  orgSpace,
} from "../src/lib/kb.ts";
import { startFakeEngine } from "./helpers/fake-engine.ts";

describe("KbEngineClient", () => {
  const engine = startFakeEngine();
  const client = new KbEngineClient({ baseUrl: engine.url });

  afterAll(() => engine.stop());

  test("addDocument binds the document to the org space", async () => {
    const r = await client.addDocument({
      content: "# Handbook\n\nAlpha procedure",
      customId: "doc:handbook",
      space: "org_alpha",
      metadata: { org_id: "alpha", source: "upload" },
    });
    expect(r.engineId).toBe("eng-doc:handbook");
    expect(engine.docs.get("doc:handbook")?.space).toBe("org_alpha");
  });

  test("search scopes to the space and normalizes results", async () => {
    const results = await client.search({ query: "Alpha procedure", space: "org_alpha" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.documentId).toBe("doc:handbook");
    expect(results[0]!.metadata.org_id).toBe("alpha");
    expect(results[0]!.score).toBeGreaterThan(0);
  });

  test("search never returns documents from another space", async () => {
    await client.addDocument({
      content: "# Org Beta secret handbook\n\nBeta procedure content",
      customId: "doc:beta-handbook",
      space: "org_beta",
      metadata: { org_id: "beta", source: "upload" },
    });
    const results = await client.search({
      query: "Beta procedure content handbook",
      space: "org_alpha",
    });
    expect(results.map((r) => r.documentId)).not.toContain("doc:beta-handbook");
  });

  test("search rejects queries that are empty or oversized", async () => {
    expect(await client.search({ query: "   ", space: "org_alpha" })).toEqual([]);
    expect(
      client.search({ query: "x".repeat(1001), space: "org_alpha" }),
    ).rejects.toBeInstanceOf(KbEngineError);
  });

  test("getDocument fails closed when the doc belongs to another org", async () => {
    const other = await client.getDocument("doc:beta-handbook", "org_alpha");
    expect(other).toBeNull();
    const own = await client.getDocument("doc:handbook", "org_alpha");
    expect(own?.documentId).toBe("doc:handbook");
  });

  test("getDocument returns null for missing docs", async () => {
    expect(await client.getDocument("doc:missing", "org_alpha")).toBeNull();
  });

  test("deleteDocument only deletes docs in the bound space", async () => {
    expect(await client.deleteDocument("doc:beta-handbook", "org_alpha")).toBe(false);
    expect(engine.docs.has("doc:beta-handbook")).toBe(true);
    expect(await client.deleteDocument("doc:handbook", "org_alpha")).toBe(true);
    expect(engine.docs.has("doc:handbook")).toBe(false);
  });

  test("engine 5xx maps to kb_unavailable", async () => {
    engine.setFailure(500);
    expect(
      client.search({ query: "anything at all", space: "org_alpha" }),
    ).rejects.toBeInstanceOf(KbUnavailableError);
    engine.setFailure(null);
  });

  test("engine 4xx maps to kb_engine_error", async () => {
    engine.setFailure(400);
    expect(
      client.search({ query: "anything at all", space: "org_alpha" }),
    ).rejects.toBeInstanceOf(KbEngineError);
    engine.setFailure(null);
  });

  test("unreachable engine maps to kb_unavailable", async () => {
    const dead = new KbEngineClient({ baseUrl: "http://localhost:9", fetch: undefined });
    expect(dead.search({ query: "anything", space: "org_alpha" })).rejects.toBeInstanceOf(
      KbUnavailableError,
    );
  });

  test("orgSpace sanitizes org ids into the space shape", () => {
    expect(orgSpace("acme corp")).toBe("org_acme-corp");
    expect(orgSpace("staka")).toBe("org_staka");
    expect(orgSpace("")).toBe("org_default");
    expect(orgSpace("Ünïcode")).toBe("org_n-code");
  });

  test("client refuses spaces outside the org_ shape", () => {
    expect(
      client.search({ query: "x", space: "everyone" }),
    ).rejects.toBeInstanceOf(KbEngineError);
    expect(
      client.addDocument({ content: "x", customId: "d", space: "../admin" }),
    ).rejects.toBeInstanceOf(KbEngineError);
  });
});
