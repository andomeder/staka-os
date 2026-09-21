import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { DbPools } from "../src/db/client.ts";
import { closeDbPools, createDb } from "../src/db/client.ts";
import { kbDocuments, users } from "../src/db/schema.ts";
import {
  corpusStats,
  deleteDocument,
  ingestDocument,
  ingestDocument as ingest,
  KbIngestError,
  profileDocument,
  syncDirectoryProfiles,
} from "../src/lib/kb-ingest.ts";
import { KbEngineClient, type KbConfig } from "../src/lib/kb.ts";
import { startFakeEngine } from "./helpers/fake-engine.ts";
import { setupTestPools } from "./helpers/db.ts";

let pools: DbPools;
let engine: ReturnType<typeof startFakeEngine>;
let kbConfig: KbConfig;

beforeAll(async () => {
  const setup = await setupTestPools();
  pools = setup.pools;
  engine = startFakeEngine();
  kbConfig = {
    client: new KbEngineClient({ baseUrl: engine.url }),
    space: "org_alpha",
  };
});

afterAll(async () => {
  if (pools) await closeDbPools(pools);
  engine.stop();
});

beforeAll(async () => {
  // The registry persists across runs while the fake engine does not.
  await pools.owner.delete(kbDocuments);
});

function ingestDeps() {
  return {
    db: pools.owner,
    client: kbConfig.client,
    space: kbConfig.space,
    orgId: "alpha",
  };
}

describe("KB ingestion", () => {
  test("ingests a markdown document and registers it", async () => {
    const deps = ingestDeps();
    const r = await ingestDocument(deps, {
      title: "Q3 reporting procedure",
      content: "# Q3 reporting procedure\n\nJohn Mwangi owns the Q3 report.",
      source: "upload",
      docType: "document",
      uploadedBy: undefined,
    });
    expect(r.customId).toMatch(/^doc:/);
    const stored = engine.docs.get(r.customId);
    expect(stored?.space).toBe("org_alpha");
    expect(stored?.metadata.org_id).toBe("alpha");
    expect(stored?.metadata.doc_type).toBe("document");

    const [row] = await deps.db
      .select()
      .from(kbDocuments)
      .where(eq(kbDocuments.customId, r.customId));
    expect(row?.title).toBe("Q3 reporting procedure");
    expect(row?.deletedAt).toBeNull();
  });

  test("rejects unsupported file types and oversized documents", async () => {
    const deps = ingestDeps();
    expect(
      ingest(deps, {
        title: "binary",
        filename: "virus.exe",
        bytes: new Uint8Array(10),
        mime: "application/octet-stream",
        source: "upload",
        docType: "document",
      }),
    ).rejects.toBeInstanceOf(KbIngestError);
    expect(
      ingest(deps, {
        title: "huge",
        content: "x".repeat(10 * 1024 * 1024 + 1),
        source: "upload",
        docType: "document",
      }),
    ).rejects.toBeInstanceOf(KbIngestError);
  });

  test("ingests file uploads through the multipart path with metadata", async () => {
    const deps = ingestDeps();
    // PDFs and text files share the engine's file endpoint; the MIME
    // gate itself is asserted by the unsupported-type test above.
    const r = await ingest(deps, {
      title: "notes",
      filename: "notes.md",
      bytes: new TextEncoder().encode("# Notes\n\nbody text"),
      mime: "text/markdown",
      source: "upload",
      docType: "document",
    });
    const stored = engine.docs.get(r.customId);
    expect(stored?.space).toBe("org_alpha");
    expect(stored?.metadata.org_id).toBe("alpha");
  });

  test("sensitive documents carry the exclusion metadata", async () => {
    const deps = ingestDeps();
    const r = await ingest(deps, {
      title: "Salary bands",
      content: "Internal salary bands. Do not show to agents.",
      source: "upload",
      docType: "document",
      sensitive: true,
    });
    expect(engine.docs.get(r.customId)?.metadata.sensitive).toBe(true);
  });

  test("delete removes the document from the engine and archives the row", async () => {
    const deps = ingestDeps();
    const r = await ingest(deps, {
      title: "Ephemeral doc",
      content: "Temporary content for deletion.",
      source: "upload",
      docType: "document",
    });
    expect(await deleteDocument(deps, r.customId)).toBe(true);
    expect(engine.docs.has(r.customId)).toBe(false);
    const [row] = await deps.db
      .select()
      .from(kbDocuments)
      .where(eq(kbDocuments.customId, r.customId));
    expect(row?.deletedAt).not.toBeNull();
    expect(await deleteDocument(deps, r.customId)).toBe(false);
  });

  test("corpus stats aggregate documents, sensitive count, and bytes", async () => {
    const deps = ingestDeps();
    await ingest(deps, {
      title: "Stats doc A",
      content: "Stats document alpha content.",
      source: "upload",
      docType: "document",
    });
    const stats = await corpusStats(deps);
    expect(stats.documents).toBeGreaterThan(0);
    expect(stats.sensitive).toBeGreaterThan(0);
    expect(stats.totalBytes).toBeGreaterThan(0);
  });

  test("directory sync ingests a profile per active user", async () => {
    const deps = ingestDeps();
    const count = await syncDirectoryProfiles(deps);
    expect(count).toBeGreaterThan(0);
    const seeded = await deps.db.select().from(users).limit(1);
    const profile = engine.docs.get(`profile:${seeded[0]!.employeeId}`);
    expect(profile?.metadata.doc_type).toBe("profile");
    expect(profile?.metadata.org_id).toBe("alpha");
    expect(profile?.content).toContain(`employee_id: ${seeded[0]!.employeeId}`);
    // employee_id is the who_knows key; email stays in the org DB, and the
    // profile doc carries it only when set.
    expect(profileDocument({ ...seeded[0]!, email: null })).not.toContain("email:");
  });

  test("re-ingesting the same customId updates instead of duplicating", async () => {
    const deps = ingestDeps();
    const first = await ingest(deps, {
      title: "Versioned doc",
      content: "First version of the shared doc.",
      source: "upload",
      docType: "document",
      customId: "doc:versioned",
    });
    const second = await ingest(deps, {
      title: "Versioned doc v2",
      content: "Second version of the shared doc.",
      source: "upload",
      docType: "document",
      customId: first.customId,
    });
    expect(second.customId).toBe(first.customId);
    const rows = await deps.db
      .select()
      .from(kbDocuments)
      .where(eq(kbDocuments.customId, first.customId));
    expect(rows.length).toBe(1);
    expect(rows[0]?.title).toBe("Versioned doc v2");
  });
});

describe("KB engine outage", () => {
  test("ingestion fails with a typed error and leaves no registry row", async () => {
    engine.setFailure(500);
    try {
      await expect(
        ingest(ingestDeps(), {
          title: "Doomed doc",
          content: "This never lands.",
          source: "upload",
          docType: "document",
        }),
      ).rejects.toBeInstanceOf(KbIngestError);
      const rows = await pools.owner
        .select()
        .from(kbDocuments)
        .where(eq(kbDocuments.title, "Doomed doc"));
      expect(rows.length).toBe(0);
    } finally {
      engine.setFailure(null);
    }
  });
});
